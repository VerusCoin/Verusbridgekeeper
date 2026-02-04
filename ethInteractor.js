const Web3 = require('web3');
const bitGoUTXO = require('bitgo-utxo-lib');
const confFile = require('./confFile.js')
const constants = require('./constants');
const ethersUtils = require('ethers').utils
const { addHexPrefix } = require('./utils');
const util = require('./utils.js');
const abi = new Web3().eth.abi
const deserializer = require('./deserializer.js');
const { 
    initApiCache, 
    initBlockCache,  
    setCachedApi, 
    getCachedApi, 
    clearCachedApis, 
    getCachedBlock, 
    setCachedBlock, 
    getCachedImport, 
    setCachedImport 
} = require('./cache/apicalls')
const notarization = require('./utilities/notarizationSerializer.js');
let log = function(){};


const enableLog = function() {
    var old = console.log;
    console.log("> Log Date Format DD/MM/YY HH:MM:SS - UTCString");
    console.log = function() {
        var n = new Date();
        var d = ("0" + (n.getDate().toString())).slice(-2),
            m = ("0" + ((n.getMonth() + 1).toString())).slice(-2),
            y = ("0" + (n.getFullYear().toString())).slice(-2),
            t = n.toUTCString().slice(-13, -4);
        Array.prototype.unshift.call(arguments, "[" + d + "/" + m + "/" + y + t + "]");
        old.apply(this, arguments);
    }
    log = console.log;
};

class EthInteractorConfig {
    constructor() {}

    init(ticker, debug, debugsubmit, debugnotarization, noimports, checkhash, userpass, rpcallowip, nowitnesssubmissions) {
        this._ticker = ticker ?? process.argv.indexOf('-testnet') > -1 ? "VRSCTEST" : "VRSC";
        this._debug = debug ?? (process.argv.indexOf('-debug') > -1);
        this._debugsubmit = debugsubmit ?? (process.argv.indexOf('-debugsubmit') > -1);
        this._debugnotarization = debugnotarization ?? (process.argv.indexOf('-debugnotarization') > -1);
        this._noimports = noimports ?? (process.argv.indexOf('-noimports') > -1);
        this._checkhash = checkhash ?? (process.argv.indexOf('-checkhash') > -1);
        this._consolelog = (process.argv.indexOf('-consolelog') > -1);
        this._nowitnesssubmit = nowitnesssubmissions;
        this._userpass = userpass;
        this._rpcallowip = rpcallowip;

        if(this._consolelog) enableLog();
    }

    get ticker() { return this._ticker };
    get debug() { return this._debug };
    get debugsubmit() { return this._debugsubmit };
    get debugnotarization() { return this._debugnotarization };
    get noimports() { return this._noimports };
    get checkhash() { return this._checkhash };
    get ethSystemId() { return constants.VETHCURRENCYID[this.ticker] };
    get verusSystemId() { return constants.VERUSSYSTEMID[this.ticker] };
    get bridgeId() { return constants.BRIDGEID[this.ticker] };
    get spendDisabled()  { return this._nowitnesssubmit };
}

const InteractorConfig = new EthInteractorConfig();

exports.InteractorConfig = InteractorConfig;

//Main coin ID's
const IAddressBaseConst = constants.IAddressBaseConst;
const RAddressBaseConst = constants.RAddressBaseConst;
const notarizationMaxGas = constants.notarizationMaxGas;
const submitImportMaxGas = constants.submitImportMaxGas;
const verusDelegatorAbi = require('./abi/VerusDelegator.json');

// Global settings
let settings = undefined;
let noaccount = false;
let web3 = undefined;
let provider = undefined;
let d = new Date();
let globalsubmitimports = { "transactionHash": "" };
let globaltimedelta = constants.globaltimedelta; //60s for getnewblocks
let globaltimedeltaNota = 300000;
let globallastinfo = d.valueOf() - globaltimedelta;
let globallastcurrency = d.valueOf() - globaltimedelta;
let globalgetlastimport = d.valueOf() - globaltimedelta;
let transactioncount = 0;
let account = undefined;
let delegatorContract = undefined;
let lastblocknumber = null;
let lasttimestamp = null
let notarizationEvent = undefined;
let blockEvent = undefined;
let webSocketFault = false;

// Connection restoration state
let restorationPromise = null;
let lastRestorationAttempt = 0;
const RESTORATION_COOLDOWN_MS = 10000; // 10 second cooldown between restoration attempts

const reconnectOptions = {
  auto: false,
  delay: 5000, // ms
  maxAttempts: 0,
  onTimeout: false,
}

const web3Options = {
    clientConfig: {
        maxReceivedFrameSize: 100000000,
        maxReceivedMessageSize: 100000000,
        keepalive: true,
        keepaliveInterval: 60000 // ms
    },
    reconnect: reconnectOptions
};

// Get median gas price from the last block's transactions
async function getMedianGasPrice() {
    const block = await web3.eth.getBlock('latest');
    if (!block || block.transactions.length === 0) {
        throw new Error('No transactions in latest block');
    }
    
    const blockTransactionNum = block.transactions.length === 1 ? 1 : Math.ceil(block.transactions.length / 2);
    const transaction = await web3.eth.getTransaction(block.transactions[blockTransactionNum - 1]);
    
    if (!transaction || !transaction.gasPrice) {
        throw new Error('Could not get gas price from transaction');
    }
    
    const baseFee = block.baseFeePerGas.toString() || '0';
    const gasPriceGwei = web3.utils.fromWei(transaction.gasPrice, 'gwei');
    const baseFeeGwei = web3.utils.fromWei(baseFee, 'gwei');
    
    console.log(`[GasPrice] Block: ${block.number}, BaseFee: ${baseFeeGwei} Gwei, GasPrice: ${gasPriceGwei} Gwei`);
    
    return transaction.gasPrice;
}

Object.assign(String.prototype, {
    reversebytes() {
        return this.match(/[a-fA-F0-9]{2}/g).reverse().join('');
    }
});

async function setupConf() {
    if (!settings) {
      settings = confFile.loadConfFile(InteractorConfig.ticker);
      if(!settings.delegatorcontractaddress) {
          throw new Error("Delegator contract address not set in conf file");
      }

      InteractorConfig._userpass = `${settings.rpcuser}:${settings.rpcpassword}`;

      // Default ip to 127.0.0.1 if not set
      InteractorConfig._rpcallowip = settings.rpcallowip || "127.0.0.1";
      InteractorConfig._nowitnesssubmit = settings.nowitnesssubmissions == "true";
    }

    if (web3) {
      await disconnectProviderSocket();
    }

    // create new provider connection    
    provider = new Web3.providers.WebsocketProvider(settings.ethnode, web3Options);
    provider.on('error', e => { log('web3 provider socket error'); });
    provider.on('end',   e => { log('web3 provider socket end'); });

    if (web3 === undefined) {
      // create new web3 object
      web3 = new Web3(provider);
      
      // add our wallet only once
      if (settings.privatekey.length == 64) {
        account = web3.eth.accounts.privateKeyToAccount(settings.privatekey);
        web3.eth.accounts.wallet.add(account);
      } else {
        noaccount = true;
      }
      
      web3.eth.handleRevert = false;
      delegatorContract = new web3.eth.Contract(verusDelegatorAbi, settings.delegatorcontractaddress);

    } else {
      // update provider on existing web3 object
      web3.setProvider(provider);
    }

    try {
      // Add timeout to prevent hanging on isListening check
      let isListening = await timeoutCheck(web3.eth.net.isListening(), 5000);
      if (isListening === true) {
        webSocketFault = false;
        log('web3 provider is connected');
        return true;
      } else {
        webSocketFault = true;
      }
    } catch (e) {
      webSocketFault = true;
      log('web3 provider connection check failed: ' + (e.message || 'timeout'));
    }
    if (webSocketFault === true) {
      log('web3 provider is offline');
    }
    return false;
}

/**
 * Initializes the ETH interactor
 * @param {{ ticker: string, debug?: boolean, debugsubmit?: boolean, debugnotarization?: boolean, noimports?: boolean, checkhash?: boolean }} config
 */
exports.init = async (config = {}) => {
    InteractorConfig.init(
        config.ticker, 
        config.debug, 
        config.debugsubmit, 
        config.debugnotarization, 
        config.noimports,
        config.checkhash,
        config.userpass,
        config.rpcallowip,
        config.nowitnesssubmissions,
    )
    
    await setupConf();
    
    initApiCache();
    initBlockCache();

    eventListener(settings.delegatorcontractaddress);

    return settings.rpcport;
};

async function disconnectProviderSocket() {
  if (notarizationEvent) {
    notarizationEvent.unsubscribe(function(error, success){});
    notarizationEvent = undefined;
  }
  if (blockEvent) {
    blockEvent.unsubscribe(function(error, success){});
    blockEvent = undefined;
  }
  if(web3) {
    web3.eth.clearSubscriptions();
    await web3.eth.currentProvider.disconnect();
    log("web3 provider disconnect");
  }
}

exports.end = disconnectProviderSocket;

exports.web3status = async () => {
    let websocketOk = false;
    try {
        if(web3) {
            websocketOk = await Promise.race([web3.eth.net.isListening(), new Promise((_r, rej) => setTimeout(rej, 3000))])
        }
    } catch (error) {
        websocketOk = false;
    }
    return websocketOk;
}

async function eventListener(notarizerAddress) {

    let options = {
        reconnect: reconnectOptions,
        address: notarizerAddress,
        topics: [
            '0x680ce19d19cb7479bae869cebd27efcca33f6f22a43fd4d52d6c62a64890b7fd'
        ]
    };

    if (notarizationEvent === undefined) {
      notarizationEvent = web3.eth.subscribe('logs', options, function(error, result) {
          if (!error) log('Notarization at ETH Height: ' +  result?.blockNumber);
          else console.log("notarizationEvent", error);
      }).on("data", function() {
          log('***** EVENT: New Notarization, Clearing the cache(data)*********');
          clearCachedApis();
          setCachedApi(null, 'lastgetNotarizationDatatime');
          // await setCachedApi(log?.blockNumber, 'lastNotarizationHeight');
      }).on("changed", function() {
          log('***** EVENT: New Notarization, Clearing the cache(changed)**********');
          clearCachedApis();
      });
    }

    if (blockEvent === undefined) {
      blockEvent = web3.eth.subscribe('newBlockHeaders', (error, blockHeader) => {
        if (error) {
          console.error("blockEvent error:", error);
        } else {
          lastblocknumber = blockHeader.number;
          lasttimestamp = blockHeader.timestamp;
          log("New block received", blockHeader.number);
        }
      });
    }
}

function amountFromValue(incoming) {
    if (incoming == 0) return 0;
    return (incoming * 100000000).toFixed(0);
}

function serializeCCurrencyValueMap(ccvm) {

    let encodedOutput = Buffer.from(util.removeHexLeader(ccvm.currency), 'hex');
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(amountFromValue(ccvm.amount), 64)]);

    return encodedOutput
}

function serializeCCurrencyValueMapVarInt(ccvm) {

    let encodedOutput = Buffer.from(util.removeHexLeader(ccvm.currency), 'hex');
    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(parseInt(ccvm.amount, 10))]);

    return encodedOutput
}

const FLAG_DEST_AUX = 64;

function serializeCTransferDestination(ctd) {

    let encodedOutput = Buffer.alloc(1);
    encodedOutput.writeUInt8(ctd.destinationtype);

    let lengthOfDestination = {};
    let destination = Buffer.from(util.removeHexLeader(ctd.destinationaddress), 'hex');

    if (ctd.destinationtype == constants.DEST_REGISTERCURRENCY ||
        ctd.destinationtype == constants.DEST_REGISTERCURRENCY + constants.FLAG_DEST_AUX) {

        lengthOfDestination = Buffer.byteLength(destination);
    } else {

        lengthOfDestination = constants.UINT160_LENGTH;

    }

    encodedOutput = Buffer.concat([encodedOutput, util.writeCompactSize(lengthOfDestination), destination]);

    if (parseInt(ctd.destinationtype & FLAG_DEST_AUX) == FLAG_DEST_AUX && destination.length != 92)
    {
        let mainVecLength = ctd.auxdests.length;

        let subLength = util.writeCompactSize(mainVecLength);

        let subvector = Buffer.from("");

        for (let i = 0; i < mainVecLength; i++)
        {
            let subType = Buffer.alloc(1);
            subType.writeUInt8(ctd.auxdests[i].type);
            let subDestination = Buffer.from(bitGoUTXO.address.fromBase58Check(ctd.auxdests[i].address, 160).hash);

            let arrayItem = Buffer.concat([subType, util.writeCompactSize(Buffer.byteLength(subDestination)), subDestination])
            subvector = Buffer.concat([subvector, util.writeCompactSize(Buffer.byteLength(arrayItem)), arrayItem])

        }

        encodedOutput = Buffer.concat([encodedOutput, subLength, subvector]);

    }

    return encodedOutput;
}



function serializeCrossChainExport(cce) {

    let encodedOutput = util.writeUInt(cce.version, 16);
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(cce.flags, 16)]);
    encodedOutput = Buffer.concat([encodedOutput, bitGoUTXO.address.fromBase58Check(cce.sourcesystemid, 160).hash]);
    //hashtransfers uint256
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(cce.hashtransfers), 'hex')]);
    encodedOutput = Buffer.concat([encodedOutput, bitGoUTXO.address.fromBase58Check(cce.destinationsystemid, 160).hash]);
    encodedOutput = Buffer.concat([encodedOutput, bitGoUTXO.address.fromBase58Check(cce.destinationcurrencyid, 160).hash]);
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from('0000', 'hex')]); //exporter set to type 00 and address length 00
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(cce.firstinput, 32)]);
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(cce.numinputs, 32)]);
    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(cce.sourceheightstart)]);
    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(cce.sourceheightend)]);
    //totalfees CCurrencyValueMap
    encodedOutput = Buffer.concat([encodedOutput, util.serializeCCurrencyValueMapArray(cce.totalfees)]);
    //totalamounts CCurrencyValueMap
    encodedOutput = Buffer.concat([encodedOutput, util.serializeCCurrencyValueMapArray(cce.totalamounts)]);
    //totalburned CCurrencyValueMap
    encodedOutput = Buffer.concat([encodedOutput, util.writeCompactSize(1), serializeCCurrencyValueMap(cce.totalburned[0])]); //fees always blank value map 0
    //CTransfer DEstionation for Reward Address

    let reserveTransfers = Buffer.alloc(1);
    reserveTransfers.writeUInt8(0); //empty reserve transfers

    encodedOutput = Buffer.concat([encodedOutput, reserveTransfers]);

    return encodedOutput;
}

function serializeCReserveTransfers(crts) {

    let encodedOutput = Buffer.from('');
    for (let i = 0; i < crts.length; i++) {
        encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(crts[i].version)]); // should be 1 for single transfer
        if (crts[i].currencyvalue)
            encodedOutput = Buffer.concat([encodedOutput, serializeCCurrencyValueMapVarInt(crts[i].currencyvalue)]); // TODO: [EB-2] Varint instead of uint64
        else
            encodedOutput = Buffer.concat([encodedOutput, serializeCCurrencyValueMapVarInt(crts[i].currencyvalues)]);

        encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(crts[i].flags)]);
        encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].feecurrencyid), 'hex')]);
        encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(crts[i].fees)]);
        encodedOutput = Buffer.concat([encodedOutput, serializeCTransferDestination(crts[i].destination)]);
        if (crts[i].destcurrencyid)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].destcurrencyid), 'hex')]);
        else
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].destinationcurrencyid), 'hex')]);
        if ((crts[i].flags & constants.RESERVE_TO_RESERVE) == constants.RESERVE_TO_RESERVE)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].secondreserveid), 'hex')]);

        if ((crts[i].flags & constants.CROSS_SYSTEM) == constants.CROSS_SYSTEM && crts[i].destsystemid)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].destsystemid), 'hex')]);
        else if ((crts[i].flags & constants.CROSS_SYSTEM) == constants.CROSS_SYSTEM && crts[i].exportto)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].exportto), 'hex')]);

    }

    return encodedOutput;
}

//takes in an array of proof strings and serializes
function serializeEthProof(proofArray) {
    if (proofArray === undefined) return null;
    let encodedOutput = util.writeVarInt(proofArray.length);
    //loop through the array and add each string length and the string
    //serialize account proof
    for (let i = 0; i < proofArray.length; i++) {
        //remove the 0x at the start of the string
        let proofElement = util.removeHexLeader(proofArray[i]);
        encodedOutput = Buffer.concat([encodedOutput, util.writeCompactSize(proofElement.length / 2)]);
        encodedOutput = Buffer.concat([encodedOutput, Buffer.from(proofElement, 'hex')]);
    }
    return encodedOutput;
}

function serializeEthFullProof(ethProof) {
    let encodedOutput = Buffer.alloc(1);
    let version = 1;
    encodedOutput.writeUInt8(version);

    let type = constants.TRANSFER_TYPE_ETH;
    let typeBuffer = Buffer.alloc(1);
    typeBuffer.writeUInt8(type);
    encodedOutput = Buffer.concat([encodedOutput, typeBuffer]);

    //write accountProof length
    let sizeBuffer = Buffer.alloc(4);
    sizeBuffer.writeUInt32LE(1);
    encodedOutput = Buffer.concat([encodedOutput, sizeBuffer]);

    let branchTypeBuffer = Buffer.alloc(1);
    branchTypeBuffer.writeUInt8(4); //eth branch type
    encodedOutput = Buffer.concat([encodedOutput, branchTypeBuffer]);
    //merkle branch base
    encodedOutput = Buffer.concat([encodedOutput, branchTypeBuffer]);

    //serialize account proof
    encodedOutput = Buffer.concat([encodedOutput, serializeEthProof(ethProof.accountProof)]);
    //serialize address bytes 20
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(ethProof.address), 'hex')]);
    let balancehex = util.removeHexLeader(web3.utils.numberToHex(ethProof.balance));
    let temphexreversed = web3.utils.padLeft(balancehex, 64).reversebytes();
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(temphexreversed, 'hex')]);

    //serialize codehash bytes 32
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(ethProof.codeHash), 'hex')]);
    //serialize nonce as uint32

    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(ethProof.nonce)]);
    //serialize storageHash bytes 32
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(ethProof.storageHash), 'hex')]);

    //loop through storage proofs
    let key = util.removeHexLeader(ethProof.storageProof[0].key);
    key = web3.utils.padLeft(key, 64);
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(key, 'hex')]);
    encodedOutput = Buffer.concat([encodedOutput, serializeEthProof(ethProof.storageProof[0].proof)]);
    return encodedOutput;
}

async function getProof(eIndex, blockHeight) {
    let index = "0000000000000000000000000000000000000000000000000000000000000000";

    let position = Buffer.alloc(4);
    position.writeUInt32BE(eIndex);
    let posString = position.toString('hex');
    posString = web3.utils.padLeft(posString, 64);

    let key = web3.utils.sha3("0x" + posString + index, { "encoding": "hex" });

    // If error thrown, it is caught in the calling function
    let proof = await web3.eth.getProof(settings.delegatorcontractaddress, [key], blockHeight);
    return proof;
}

// create the component parts for the proof

function createComponents(transfers, startHeight, endHeight, previousExportHash, bridgeConverterActive) {

    let cce = createCrossChainExport(transfers, startHeight, endHeight, false, bridgeConverterActive);
    //Var Int Components size as this can only
    let encodedOutput = util.writeCompactSize(1);
    //eltype
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(7, 16)]);
    //elIdx
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(0, 16)]);
    //elVchObj
    let exportKey = constants.VDXFDATAKEY[InteractorConfig.ticker];
    let serializedVDXF = Buffer.from(exportKey, 'hex');
    let version = 1;
    serializedVDXF = Buffer.concat([serializedVDXF, util.writeUInt(version, 1)]);

    let serialized = Buffer.from(serializeCrossChainExport(cce));

    let prevhash = Buffer.from(util.removeHexLeader(previousExportHash), 'hex');

    serialized = Buffer.concat([serialized, prevhash]);

    if (InteractorConfig.checkhash) {
        let hashofcce_reserves = ethersUtils.keccak256(serialized);
        let serialization = Buffer.concat([serializeCrossChainExport(cce), prevhash]);
        console.log("Hash of cce + prevhash: ", hashofcce_reserves.toString('hex'));
        console.log("serialization of ccx + previous txid hash: ", serialization.toString('hex'));
    }

    serialized = Buffer.concat([util.writeCompactSize(serialized.length), serialized]);

    serialized = Buffer.concat([serializedVDXF, serialized]);

    serialized = Buffer.concat([util.writeCompactSize(serialized.length), serialized]);

    encodedOutput = Buffer.concat([encodedOutput, serialized]);
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from('00000000', 'hex')]); //no elproof
    return encodedOutput.toString('Hex');

}
//create an outbound trans
function createOutboundTransfers(transfers) {
    let outTransfers = [];
    for (let i = 0; i < transfers.length; i++) {
        let transfer = transfers[i];
        let outTransfer = {};
        outTransfer.version = 1;
        outTransfer.currencyvalues = {
            [util.ethAddressToVAddress(transfer.currencyvalue.currency, IAddressBaseConst)]: util.uint64ToVerusFloat(transfer.currencyvalue.amount)
        };
        outTransfer.flags = transfer.flags;
        if ((parseInt(outTransfer.flags) & constants.CROSS_SYSTEM) == constants.CROSS_SYSTEM) {
            outTransfer.exportto = util.ethAddressToVAddress(transfer.destsystemid, IAddressBaseConst);
        }
        outTransfer.feecurrencyid = util.ethAddressToVAddress(transfer.feecurrencyid, IAddressBaseConst);
        outTransfer.fees = util.uint64ToVerusFloat(transfer.fees);

        if ((parseInt(transfer.flags) & constants.RESERVETORESERVE) == constants.RESERVETORESERVE) {
            outTransfer.destinationcurrencyid = util.ethAddressToVAddress(transfer.secondreserveid, IAddressBaseConst);
            outTransfer.via = util.ethAddressToVAddress(transfer.destcurrencyid, IAddressBaseConst);
        } else {
            outTransfer.destinationcurrencyid = util.ethAddressToVAddress(transfer.destcurrencyid, IAddressBaseConst);
        }

        let address = {};

        address = util.hexAddressToBase58(transfer.destination.destinationtype, transfer.destination.destinationaddress.slice(0, 42));

        if (transfer.destination.destinationaddress.length > 42)
            outTransfer.destination = {
            "type": transfer.destination.destinationtype,
            "address": address,
            "gateway": util.ethAddressToVAddress(transfer.destination.destinationaddress.slice(42, 82), IAddressBaseConst),
            "fees": parseInt(transfer.destination.destinationaddress.slice(122, 138).reversebytes(), 16) / 100000000
        }
        else{
            outTransfer.destination = {
                "type": transfer.destination.destinationtype,
                "address": address
            }
        }
        if ((parseInt(transfer.destination.destinationtype & constants.FLAG_DEST_AUX)) == constants.FLAG_DEST_AUX) 
        {
            const auxType = parseInt(transfer.destination.destinationaddress.slice(142,144), 16);
            const auxAddress = util.hexAddressToBase58(auxType, transfer.destination.destinationaddress.slice(146))
            outTransfer.destination.auxdests = [{type: auxType, address: auxAddress}]
        } 

        outTransfers.push(outTransfer);
    }
    return outTransfers;
}

function createCrossChainExport(transfers, startHeight, endHeight, jsonready = false, bridgeConverterActive) {
    let cce = {};
    let hash = ethersUtils.keccak256(serializeCReserveTransfers(transfers));
    if (InteractorConfig.checkhash) {
        console.log("hash of transfers: ",hash.toString('Hex'));
    }
    cce.version = 1;
    cce.flags = 2;
    cce.sourcesystemid = InteractorConfig.ethSystemId;
    cce.hashtransfers = hash;
    cce.destinationsystemid = InteractorConfig.verusSystemId;

    if (bridgeConverterActive) {
        cce.destinationcurrencyid = InteractorConfig.bridgeId;
    } else {
        cce.destinationcurrencyid = InteractorConfig.verusSystemId;
    }

    cce.sourceheightstart = startHeight;
    cce.sourceheightend = endHeight;
    cce.numinputs = transfers.length;
    cce.totalamounts = [];
    let totalamounts = [];
    cce.totalfees = [];
    let totalfees = [];
    for (let i = 0; i < transfers.length; i++) {
        //sum up all the currencies
        if (util.uint160ToVAddress(transfers[i].currencyvalue.currency, IAddressBaseConst) in totalamounts)
            totalamounts[util.uint160ToVAddress(transfers[i].currencyvalue.currency, IAddressBaseConst)] += parseInt(transfers[i].currencyvalue.amount);
        else
            totalamounts[util.uint160ToVAddress(transfers[i].currencyvalue.currency, IAddressBaseConst)] = parseInt(transfers[i].currencyvalue.amount);
        //add fees to the total amounts
        if (util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst) in totalamounts)
            totalamounts[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] += parseInt(transfers[i].fees);
        else
            totalamounts[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] = parseInt(transfers[i].fees);


        if (util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst) in totalfees)
            totalfees[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] += parseInt(transfers[i].fees);
        else
            totalfees[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] = parseInt(transfers[i].fees);
    }
    for (let key in totalamounts) {
        cce.totalamounts.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalamounts[key]) : totalamounts[key]) });
    }
    for (let key in totalfees) {
        cce.totalfees.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalfees[key]) : totalfees[key]) });
    }

    cce.totalburned = [{ "currency": '0x0000000000000000000000000000000000000000', "amount": 0 }]; // serialiser doesnt like empty strings or non BIgints
    cce.rewardaddress = ""; //  blank
    cce.firstinput = 1;
    if (InteractorConfig.debugsubmit) {
        console.log("cce", JSON.stringify(cce),null,2);
    }
    return cce;
}

// function createCrossChainExportToETH(transfers, blockHeight, jsonready = false) {
//     let cce = {};
//     let hash = ethersUtils.keccak256(serializeCReserveTransfers(transfers));
//     if (InteractorConfig.checkhash) {
//         console.log("hash of transfers: ",hash.toString('Hex'));
//         console.log("Serialize: ",serializeCReserveTransfers(transfers).slice(1).toString('Hex'));
//     }
//     cce.version = 1;
//     cce.flags = 2;
//     cce.sourcesystemid = util.convertVerusAddressToEthAddress(ETHSystemID);
//     cce.hashtransfers = addHexPrefix(hash);
//     cce.destinationsystemid = util.convertVerusAddressToEthAddress(InteractorConfig.verusSystemId);

//     if (transfers[0].destcurrencyid.slice(0, 2) == "0x" && transfers[0].destcurrencyid.length == 42) {
//         cce.destinationcurrencyid = transfers[0].destcurrencyid;
//     } else {
//         cce.destinationcurrencyid = util.convertVerusAddressToEthAddress(transfers[0].destcurrencyid);
//     }

//     cce.sourceheightstart = 1;
//     cce.sourceheightend = 2;

//     cce.numinputs = transfers.length;
//     cce.totalamounts = [];
//     let totalamounts = [];
//     cce.totalfees = [];
//     let totalfees = [];

//     for (let i = 0; i < transfers.length; i++) {
//         //sum up all the currencies
//         if (transfers[i].currencyvalue.currency in totalamounts)
//             totalamounts[transfers[i].currencyvalue.currency] += transfers[i].currencyvalue.amount;
//         else
//             totalamounts[transfers[i].currencyvalue.currency] = transfers[i].currencyvalue.amount;
//         //add fees to the total amounts
//         if (transfers[i].feecurrencyid in totalamounts)
//             totalamounts[transfers[i].feecurrencyid] += transfers[i].fees;
//         else
//             totalamounts[transfers[i].feecurrencyid] = transfers[i].fees;

//         if (transfers[i].feecurrencyid in totalfees)
//             totalfees[transfers[i].feecurrencyid] += transfers[i].fees;
//         else
//             totalfees[transfers[i].feecurrencyid] = transfers[i].fees;
//     }
//     for (let key in totalamounts) {
//         cce.totalamounts.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalamounts[key]) : totalamounts[key]) });
//     }
//     for (let key in totalfees) {
//         cce.totalfees.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalfees[key]) : totalfees[key]) });
//     }

//     cce.totalburned = [{ "currency": '0x0000000000000000000000000000000000000000', "amount": 0 }];
//     cce.rewardaddress = {};
//     cce.firstinput = 1;
//     return cce;
// }

async function restoreProviderSocket() {
  const now = Date.now();
  
  // If there's an ongoing restoration, wait for it instead of returning false
  if (restorationPromise !== null) {
    log("web3 provider is already being restored, waiting...");
    try {
      return await restorationPromise;
    } catch (e) {
      return false;
    }
  }
  
  // Check cooldown to prevent rapid-fire restoration attempts
  if (now - lastRestorationAttempt < RESTORATION_COOLDOWN_MS) {
    const remainingCooldown = Math.ceil((RESTORATION_COOLDOWN_MS - (now - lastRestorationAttempt)) / 1000);
    log(`web3 restoration on cooldown, ${remainingCooldown}s remaining`);
    return false;
  }
  
  lastRestorationAttempt = now;
  
  // Create a promise that concurrent callers can await
  restorationPromise = (async () => {
    try {
      log("Attempting to restore web3 provider...");
      let online = await setupConf();
      if (online) {
        clearCachedApis();
        eventListener(settings.delegatorcontractaddress);
        log("web3 provider restored successfully");
      } else {
        log("web3 provider restoration failed");
      }
      return online;
    } catch (e) {
      log("web3 provider restoration error: " + (e.message || e));
      return false;
    } finally {
      restorationPromise = null;
    }
  })();
  
  return restorationPromise;
}

/** core functions */
const timeoutCheck = (prom, time) => Promise.race([prom, new Promise((_r, rej) => setTimeout(rej, time))]);

async function isProviderSocketOnline() {
  let online = false;
  
  // First check if web3 exists
  if (!web3) {
    log('web3 is not initialized');
    return false;
  }
  
  try {
    online = await timeoutCheck(web3.eth.net.isListening(), 5000);
  } catch (e) {
    online = false;
    log('web3 isListening check failed: ' + (e.message || 'timeout'));
  }
  
  if (!online) {
    // attempt to restore/re-connect
    online = await restoreProviderSocket();
  }
  
  return online === true;
}

exports.getInfo = async() => {
    //getinfo is just tested to see that its not null therefore we can just return the version
    //check that we can connect to Ethereum if not return null to kill the connection
    try {
        var d = new Date();
        var timenow = d.valueOf();
        let cacheGetInfo = await getCachedApi('getInfo');
        let getInfo = cacheGetInfo ? JSON.parse(cacheGetInfo) : null;
        
        if (globaltimedelta + globallastinfo < timenow || !getInfo) {
            let isOnline = await isProviderSocketOnline();
            if (isOnline !== true) {
              return { "result": { error: true, message: "web3 provider is not connected" } };
            }

            globallastinfo = timenow;
            const blknum = lastblocknumber;
            const timestamp  = lasttimestamp;
            if(!timestamp) {
                return { "result": null };
            }
            getinfo = {
                "version": 2000753,
                "name": "vETH",
                "VRSCversion": constants.VERSION,
                "blocks": blknum,
                "tiptime": timestamp,
                "chainid": constants.VETHCURRENCYID[InteractorConfig.ticker]
            }
            log("Command: getinfo");
            await setCachedApi(getinfo, 'getInfo');
        }

        return { "result": getinfo };
        
        
    } catch (error) {
        console.log( "Error getInfo:" + error);
        return { "result": { "error": true, "message": error } };
    }
}

exports.getCurrency = async(input) => {
    try {
        let currency = input[0];
        var d = new Date();
        var timenow = d.valueOf();
        let cacheGetCurrency = await getCachedApi('getCurrency');
        let getCurrency = cacheGetCurrency ? JSON.parse(cacheGetCurrency) : null;

        if (globaltimedelta + globallastcurrency < timenow || !getCurrency) {

            globallastcurrency = timenow;
            let info = await delegatorContract.methods.getcurrency(util.convertVerusAddressToEthAddress(currency)).call();
            let notaries = [];
            let abiPattern = ['uint', 'string', 'address', 'address', 'address', 'uint8', 'uint8', [
                ['uint8', 'bytes']
            ], 'address', 'uint', 'uint', 'uint256', 'uint256', 'address', 'address[]', 'uint']

            let decodedParams = abi.decodeParameters(abiPattern,
                "0x" + info.slice(66));

            for (let i = 0; i < decodedParams[14].length; i++) {
                notaries[i] = util.ethAddressToVAddress(decodedParams[14][i], IAddressBaseConst);
            }

            getCurrency = {
                "version": decodedParams[0],
                "name": decodedParams[1],
                "options": (decodedParams[1] === "VETH") ? 172 : 96,
                "currencyid": util.uint160ToVAddress(decodedParams[2], IAddressBaseConst),
                "parent": util.uint160ToVAddress(decodedParams[3], IAddressBaseConst),
                "systemid": util.uint160ToVAddress(decodedParams[4], IAddressBaseConst),
                "notarizationprotocol": decodedParams[5],
                "proofprotocol": decodedParams[6],
                "nativecurrencyid": { "address": '0x' + BigInt(decodedParams[7][1], IAddressBaseConst).toString(16), "type": decodedParams[7][0] },
                "launchsystemid": util.uint160ToVAddress(decodedParams[8], IAddressBaseConst),
                "startblock": decodedParams[9],
                "endblock": decodedParams[10],
                "initialsupply": decodedParams[11],
                "prelaunchcarveout": decodedParams[12],
                "gatewayid": util.uint160ToVAddress(decodedParams[13], IAddressBaseConst),
                "notaries": notaries,
                "minnotariesconfirm": decodedParams[15],
                "gatewayconvertername": "Bridge"
            };
            log("Command: getcurrency");
            await setCachedApi(getCurrency, 'getCurrency');
        }

        return { "result": getCurrency };
    } catch (error) {
        console.log( "getCurrency:" + error);
        return { "result": { "error": true, "message": error } };
    }
}

exports.getExports = async(input) => {
    let output = [];
    const lastCTransferArray = await getCachedApi('lastgetExports');
    const lastGetExport = await getCachedApi('lastgetExportResult');
    let chainname = input[0];
    let heightstart = input[1];
    let heightend = input[2];

    let srtInput = JSON.stringify(input);
    if (lastCTransferArray == srtInput && lastGetExport) {
        return { "result": JSON.parse(lastGetExport) };
    }

    // web3 connection management
    let isOnline = await isProviderSocketOnline();
    if (isOnline !== true) {
      return { "result": { error: true, message: "web3 provider is not connected" } };
    }

    heightstart = heightstart == 1 ? 0 : heightstart;

    try {
        //input chainname should always be VETH
        let bridgeConverterActive;

        if (chainname != constants.VERUSSYSTEMID[InteractorConfig.ticker]) throw `i-Address not ${InteractorConfig.ticker}`;

        let exportSets = [];
        const previousStartHeight = await delegatorContract.methods.exportHeights(heightstart).call();
        exportSets = await delegatorContract.methods.getReadyExportsByRange(previousStartHeight, heightend).call();

        log("Height end: ", heightend, "heightStart:", heightstart, {previousStartHeight});

        for (const exportSet of exportSets) {
            //loop through and add in the proofs for each export set and the additional fields

            let outputSet = {};

            const importCurrency = (parseInt(exportSet.transfers[0].flags) & constants.FLAG_IMPORT_TO_SOURCE) > 0 ? 
                                        exportSet.transfers[0].currencyvalue.currency : 
                                          exportSet.transfers[0].destcurrencyid ;
            bridgeConverterActive = (importCurrency.toLowerCase() === constants.BRIDGECURRENCYHEX[InteractorConfig.ticker].toLowerCase())
                                   
            outputSet.height = exportSet.endHeight;
            outputSet.txid = util.removeHexLeader(exportSet.exportHash).reversebytes(); //export hash used for txid
            outputSet.txoutnum = 0; //exportSet.position;
            outputSet.exportinfo = createCrossChainExport(exportSet.transfers, exportSet.startHeight, exportSet.endHeight, true, bridgeConverterActive);
            outputSet.partialtransactionproof = await getProof(exportSet.startHeight, heightend);

            //serialize the prooflet index
            let components = createComponents(exportSet.transfers, exportSet.startHeight, exportSet.endHeight, exportSet.prevExportHash, bridgeConverterActive);
            outputSet.partialtransactionproof = serializeEthFullProof(outputSet.partialtransactionproof).toString('hex') + components;

            //build transfer list
            //get the transactions at the index
            let test = await delegatorContract.methods._readyExports(outputSet.height).call();
            outputSet.transfers = createOutboundTransfers(exportSet.transfers);
            if (InteractorConfig.debugnotarization)
                console.log("First Ethereum Send to Verus: ", outputSet.transfers[0].currencyvalues, " to ", outputSet.transfers[0].destination);
            //loop through the
            output.push(outputSet);

        }

        if (InteractorConfig.debugsubmit) {
            console.log(JSON.stringify(output, null, 2));
        }

        await setCachedApi(input, 'lastgetExports');
        await setCachedApi(output, 'lastgetExportResult');
        return { "result": output };

    } catch (error) {
        let message = "unknown";
        if (error && error.message == "Returned error: execution reverted" && heightstart == 0)
            message = "First get Export call, no exports found.";
        else if (error && error.message)
            message = error.message;
        else if (error)
          message = JSON.stringify(error);
        
        console.log("getExports error:", message);
        return { "result": { "error": true, "message": message } };
    }
}

exports.getBestProofRoot = async(input) => {
    //loop through the proofroots and check each one

    let proofroots = input[0].proofroots;
    let bestindex = -1;
    let validindexes = [];
    let latestproofroot = {};
    var d = new Date();
    var timenow = d.valueOf();
    const lastTime = await getCachedApi('lastBestProofinputtime');
    let latestBlock = null;
    let cachedValue = await getCachedApi('lastGetBestProofRoot');

     if (cachedValue) {

        if (lastTime && (JSON.parse(lastTime) + 20000) < timenow) {

            latestBlock = lastblocknumber; //await web3.eth.getBlockNumber();
            await setCachedApi(latestBlock, 'lastGetBestProofRoot');
        }
        else {
            latestBlock = cachedValue
        }
     }
     else {
        // wait for block to come in, this is only normally for the first 15 seconds of startup
        if (lastblocknumber){
            latestBlock = lastblocknumber; //await web3.eth.getBlockNumber();
            await setCachedApi(latestBlock, 'lastGetBestProofRoot');
        }
        return { "result": { "error": true } };
     }


    setCachedApi(timenow, 'lastBestProofinputtime');

    try {
        if (input.length && proofroots) {
            for (let i = 0; i < proofroots.length; i++) {

                if (parseInt(proofroots[i].height) < (InteractorConfig.ticker === "VRSCTEST" ? constants.TESTNET_ETH_CONTRACT_START_HEIGHT : constants.ETH_CONTRACT_START_HEIGHT)){
                    log("height: " + proofroots[i].height + ", is greater than contract start height");
                    continue;
                }  
                if (await checkProofRoot(proofroots[i])) {
                    validindexes.push(i);
                    if (bestindex == -1)
                        bestindex = 0;
                    if (proofroots[bestindex].height < proofroots[i].height) {
                        bestindex = i;
                    }
                }
                else if (InteractorConfig.debugnotarization) {
                    log("invalid proofroot at index: ", i);
                }
            }
        }

        let latestProofHeight = 0;

        if(bestindex != -1)
            latestProofHeight = proofroots[bestindex].height;

        if (parseInt(latestProofHeight) >= (parseInt(latestBlock) - 30)) {
            latestproofroot = proofroots[bestindex];
        } else {
            // Potential save calls to getProofRoot by caching last proof root at latestBlock - 30;
            latestproofroot = await getProofRoot(parseInt(latestBlock) - 30);
        }

        let laststableproofroot = null;

        laststableproofroot = await getProofRoot(parseInt(latestBlock) - 30);

        if (InteractorConfig.debugnotarization) {
            console.log("getbestproofroot result:", { bestindex, validindexes, latestproofroot, laststableproofroot });
        }

        let retval = { "result": { bestindex, validindexes, latestproofroot, laststableproofroot} };

        return retval;

    } catch (error) {
        let message = "unknown";
        if (error && error.message)
            message = error.message;
        else if (error)
          message = JSON.stringify(error);
        
        console.log("getBestProofRoot error:", message);
        return { "result": { "error": true, "message": message } };
    }
}

async function getProofRoot(height = "latest") {
    let block;
    let transaction;
    let latestproofroot = {};
    const cachedBlock = await getCachedBlock(`${height}`);
    if (!cachedBlock)
    {
        let isOnline = await isProviderSocketOnline();
        if (isOnline !== true) {
          throw new Error("[getProofRoot] web3 provider is not connected");
        }
      
        try {
            block = await web3.eth.getBlock(height);
            if (block.transactions.length == 0) {
                throw  new Error(`No Transactions for Block: ${height}`);
            }
            const blockTransactionNum = block.transactions.length == 1 ? 1 : Math.ceil(block.transactions.length / 2);
            transaction = await web3.eth.getTransaction(block.transactions[blockTransactionNum]);

        } catch (error) {
            throw new Error("[getProofRoot] " + (error.message ? error.message : error));
        }

        let gasPriceInSATS = (BigInt(transaction.gasPrice) / BigInt(10))

        latestproofroot.height = block.number;

        if (latestproofroot.height < (InteractorConfig.ticker === "VRSCTEST" ? constants.TESTNET_ETH_GAS_REDUCTION_HEIGHT : constants.ETH_GAS_REDUCTION_HEIGHT))
        {
            latestproofroot.gasprice = gasPriceInSATS < BigInt(1000000000) ? "10.00000000" : util.uint64ToVerusFloat(gasPriceInSATS);
        }
        else if (latestproofroot.height >= (InteractorConfig.ticker === "VRSCTEST" ? constants.TESTNET_ETH_GAS_REDUCTION_HEIGHT3 : constants.ETH_GAS_REDUCTION_HEIGHT3))
        {
            const adjustedGas = gasPriceInSATS * BigInt(12) / BigInt(10);
            latestproofroot.gasprice = adjustedGas < BigInt(100000000) ? "1.00000000" : util.uint64ToVerusFloat(adjustedGas);
        }
        else if (latestproofroot.height >= (InteractorConfig.ticker === "VRSCTEST" ? constants.TESTNET_ETH_GAS_REDUCTION_HEIGHT2 : constants.ETH_GAS_REDUCTION_HEIGHT2))
        {
            const adjustedGas = gasPriceInSATS * BigInt(12) / BigInt(10);
            latestproofroot.gasprice = adjustedGas < BigInt(100000000) ? "1.00000000" : util.uint64ToVerusFloat(adjustedGas);
        }
        else
        {
            latestproofroot.gasprice = gasPriceInSATS < BigInt(500000000) ? "5.00000000" : util.uint64ToVerusFloat(gasPriceInSATS);
        }

        latestproofroot.version = 1;
        latestproofroot.type = 2;
        latestproofroot.systemid = InteractorConfig.ethSystemId;
        latestproofroot.stateroot = util.removeHexLeader(block.stateRoot).reversebytes();
        latestproofroot.blockhash = util.removeHexLeader(block.hash).reversebytes();
        latestproofroot.power = BigInt(block?.totalDifficulty || '0').toString(16);

        await setCachedBlock( latestproofroot, `${height}` )

    }
    else
    {
        latestproofroot = JSON.parse(cachedBlock);
    }

    if (InteractorConfig.debugnotarization)
        console.log("getProofRoot GASPRICE: " + latestproofroot.gasprice + ", height: " + height)

    return latestproofroot;

}

// check code is a mess because it compensates for multiple past errors in checking to ensure all block ranges are
// checked or not checked appropriately
// at a future date, after the check3 condition is passed, it could be reasonable to not check anything besides check3,
// which would enable significant cleanup
async function checkProofRoot({height, stateroot, blockhash, power, gasprice, version, type, systemid}) {
    let block;
    let transaction;
    let latestproofroot = {};
    let gasToCheckInSats = BigInt(util.convertToInt64(gasprice));

    const cachedBlock = await getCachedBlock(`${height}`);
    let gasPriceInSATS = BigInt(0);
    let checkPassed = false;

    let check3 = false;
    let check2 = false;
    let check1 = height < (InteractorConfig.ticker === "VRSCTEST" ? constants.TESTNET_ETH_GAS_REDUCTION_HEIGHT : constants.ETH_GAS_REDUCTION_HEIGHT);
    if (!check1)
    {
        check3 = height >= (InteractorConfig.ticker === "VRSCTEST" ? constants.TESTNET_ETH_GAS_REDUCTION_HEIGHT3 : constants.ETH_GAS_REDUCTION_HEIGHT3);
    }
    else if (!check3)
    {
        check2 = height >= (InteractorConfig.ticker === "VRSCTEST" ? constants.TESTNET_ETH_GAS_REDUCTION_HEIGHT2 : constants.ETH_GAS_REDUCTION_HEIGHT2);
    }

    if (!cachedBlock)
    {
        let isOnline = await isProviderSocketOnline();
        if (isOnline !== true) 
        {
          throw new Error("[checkProofRoot] web3 provider is not connected");
        }
      
        try {
            block = await web3.eth.getBlock(height);
            transaction = await web3.eth.getTransaction(block.transactions[Math.ceil(block.transactions.length / 2)]);
        } catch (error) {
            throw new Error("checkProofRoot error:", (error.message?error.message:error), height);
        }

        gasPriceInSATS = (BigInt(transaction.gasPrice) / BigInt(10))
        latestproofroot.height = block.number;
        latestproofroot.version = constants.ETH_NOTARIZATION_DEFAULT_VERSION;
        latestproofroot.type = constants.ETH_NOTARIZATION_DEFAULT_TYPE;
        latestproofroot.systemid = InteractorConfig.ethSystemId;
        latestproofroot.stateroot = util.removeHexLeader(block.stateRoot).reversebytes();
        latestproofroot.blockhash = util.removeHexLeader(block.hash).reversebytes();

        if (check1)
        {
            latestproofroot.gasprice = gasPriceInSATS < BigInt(1000000000) ? "10.00000000" : util.uint64ToVerusFloat(gasPriceInSATS);
        }
        else if (check3)
        {
            gasPriceInSATS = gasPriceInSATS * BigInt(12) / BigInt(10);
            latestproofroot.gasprice = gasPriceInSATS < BigInt(100000000) ? "1.00000000" : util.uint64ToVerusFloat(gasPriceInSATS);
        }
        else if (check2)
        {
            gasPriceInSATS = (gasPriceInSATS * BigInt(12) / BigInt(10)) < BigInt(100000000) ? BigInt(100000000) : (gasPriceInSATS * BigInt(12) / BigInt(10));
            latestproofroot.gasprice = util.uint64ToVerusFloat(gasPriceInSATS);
        }
        else
        {
            latestproofroot.gasprice = gasPriceInSATS < BigInt(500000000) ? "5.00000000" : util.uint64ToVerusFloat(gasPriceInSATS);
        }
    }
    else
    {
        latestproofroot = JSON.parse(cachedBlock);
        gasPriceInSATS = BigInt(util.convertToInt64(latestproofroot.gasprice));
    }

    if (check1)
    {
        checkPassed = true;
    }
    else if (check3)
    {
        checkPassed = (util.uint64ToVerusFloat(gasToCheckInSats) == latestproofroot.gasprice);
    }
    else if (check2)
    {
        checkPassed = (gasToCheckInSats < BigInt(500000000) && gasToCheckInSats >= BigInt(100000000) && gasPriceInSATS == gasToCheckInSats) || 
                        (gasToCheckInSats) >= BigInt(500000000);            
    }
    else
    {
        checkPassed = true;
    }
    
    if (!cachedBlock)
    {
        await setCachedBlock( latestproofroot, `${height}` )        
    }

    if (InteractorConfig.debugnotarization) 
    {
        console.log("checkProofRoot GASPRICE: " + latestproofroot.gasprice + ", height: " + height);
    }

    if (!checkPassed)
    {
        return false;
    }
        
    if (version != constants.ETH_NOTARIZATION_DEFAULT_VERSION || type != constants.ETH_NOTARIZATION_DEFAULT_TYPE || 
        (systemid != constants.VETHCURRENCYID.VRSC && systemid != constants.VETHCURRENCYID.VRSCTEST))
    {
        return false;
    }

    if (latestproofroot.stateroot != stateroot || latestproofroot.blockhash != blockhash) 
    {
        return false;
    }

    if (power == '000000000000000000000000000000000000000000000000003c656d23029ab0' || //testnet sepolia
            power == '000000000000000000000000000000000000000000000c70d815d562d3cfa955' || //mainnet
            BigInt(power) == BigInt(0)) 
    {
        return true;
    }

    return false;
}

//return the data required for a notarisation to be made
exports.getNotarizationData = async() => {

    let Notarization = {};
    Notarization.version = constants.VERSION_NOTARIZATIONDATA_CURRENT;

    var d = new Date();
    var timenow = d.valueOf();
    
    const lastTime = await getCachedApi('lastgetNotarizationDatatime');
    
    if (lastTime && (JSON.parse(lastTime) + globaltimedeltaNota) > timenow) {
        let tempNotData = await getCachedApi('lastgetNotarizationData');
        if (tempNotData) {
            return JSON.parse(tempNotData);
        }
    }
    newNotarization = false;
    await setCachedApi(timenow, 'lastgetNotarizationDatatime');
    
    try {
        let forksData = [];
        let forks = [];
        let j = 0
        let notarizations = {};
        let largestIndex = 0;

        let calcIndex = 0;
        const MAX_FORKS_ITERATIONS = 100; // Safety limit to prevent infinite loop

        try {
            while (j < MAX_FORKS_ITERATIONS) {
                let notarization = await delegatorContract.methods.bestForks(j).call();
                notarization = util.removeHexLeader(notarization);
                //if mod is 0 then the length is the new type of notarization.
                const lengthMod = notarization.length % constants.LIF.FORKLEN;
                const voutPosition = lengthMod == 0 ? constants.LIF.NPOS : constants.LIF.NPOS_VRSCTEST;
                const forkLength = lengthMod == 0 ? constants.LIF.FORKLEN : constants.LIF.FORKLEN_VRSCTEST;
                
                if (notarization && notarization.length >= forkLength) {
                    let length = notarization.length / forkLength;

                    for (let i = 0; length > i; i++) {

                        let hashPos = constants.LIF.HASHPOS + (i * forkLength);
                        let txidPos = constants.LIF.TXIDPOS + (i * forkLength);
                        let nPos = voutPosition + (i * forkLength);
                        if (largestIndex < calcIndex)
                        {
                            largestIndex = calcIndex;
                            Notarization.bestchain = j;
                        }

                        if ((j == 0  && i == 0) || i > 0)
                        {
                            notarizations[calcIndex] = {
                                txid: "0x" + notarization.substring(txidPos, txidPos + constants.LIF.BYTES32SIZE).reversebytes(),
                                n: parseInt(notarization.slice(nPos, nPos + 8), constants.LIF.HEX),
                                hash: "0x" + notarization.substring(hashPos, hashPos + constants.LIF.BYTES32SIZE).reversebytes()
                            };
                            forksData.push(calcIndex);
                            calcIndex++;
                        }
                        else{
                            forksData.push(0);
                        }

                    }
                    forks.push(forksData);
                    forksData = [];
                    j++;
                } else
                    break;
            }
        } catch (e) {
            let test1 = e;
        }

        if (forks.length == 0) {
            Notarization.forks = [];
            Notarization.lastconfirmed = -1;
            Notarization.bestchain = -1;
        } else {
            Notarization.forks = forks;
            Notarization.lastconfirmed = forks.length == 1 && forks[0].length == 1 ? -1 : 0;
            Notarization.notarizations = [];

            for (const index in notarizations) {
                Notarization.notarizations.push({
                    index: parseInt(index),
                    txid: util.removeHexLeader(notarizations[index].txid),
                    vout: notarizations[index].n,
                });
            }
        }

        if (InteractorConfig.debugnotarization) {
            console.log("NOTARIZATION CONTRACT INFO \n" + JSON.stringify(Notarization, null, 2))
        }

        await setCachedApi({ "result": Notarization }, 'lastgetNotarizationData');

        return { "result": Notarization };

    } catch (error) {
        console.log( "getNotarizationData: (No spend tx) S" + error.message);
        log("API_ERROR_GETNOTARIZATIONDATA");
        return { "result": { "error": true, "message": error.message } };
    }
}

function conditionSubmitImports(CTransferArray) {

    for (let i = 0; i < CTransferArray.length; i++) {

        CTransferArray[i].notarizationtxid = addHexPrefix(CTransferArray[i].notarizationtxid);
        CTransferArray[i].sourcesystemid = util.convertVerusAddressToEthAddress(CTransferArray[i].sourcesystemid);
        for (let j = 0; j < CTransferArray[i].exports.length; j++) {
            CTransferArray[i].exports[j].partialtransactionproof = addHexPrefix(CTransferArray[i].exports[j].partialtransactionproof);
            CTransferArray[i].exports[j].txid = addHexPrefix(CTransferArray[i].exports[j].txid.reversebytes());
            for (let k = 0; k < CTransferArray[i].exports[j].transfers.length; k++) {

                let keys = Object.keys(CTransferArray[i].exports[j].transfers[k].currencyvalues);

                for (const vals of keys) {
                    CTransferArray[i].exports[j].transfers[k].currencyvalues[util.convertVerusAddressToEthAddress(vals)] =
                        parseInt(util.convertToInt64(CTransferArray[i].exports[j].transfers[k].currencyvalues[vals]));
                    delete CTransferArray[i].exports[j].transfers[k].currencyvalues[vals];
                }
                if (CTransferArray[i].exports[j].transfers[k].destination.type == 4 ||
                    CTransferArray[i].exports[j].transfers[k].destination.type == 2) //type PKH or ID
                {
                    CTransferArray[i].exports[j].transfers[k].destination.address =
                        util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].destination.address);
                }
                if (CTransferArray[i].exports[j].transfers[k].destination.type == constants.DEST_REGISTERCURRENCY ||
                    CTransferArray[i].exports[j].transfers[k].destination.type == constants.DEST_REGISTERCURRENCY + constants.FLAG_DEST_AUX ||
                    CTransferArray[i].exports[j].transfers[k].destination.type == constants.DEST_FULLID) {

                    CTransferArray[i].exports[j].transfers[k].destination.address = "0x" + CTransferArray[i].exports[j].transfers[k].destination.serializeddata;
                }

                CTransferArray[i].exports[j].transfers[k].destinationcurrencyid =
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].destinationcurrencyid);
                CTransferArray[i].exports[j].transfers[k].exportto =
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].exportto);
                CTransferArray[i].exports[j].transfers[k].feecurrencyid =
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].feecurrencyid);
                CTransferArray[i].exports[j].transfers[k].fees =
                    parseInt(util.convertToInt64(CTransferArray[i].exports[j].transfers[k].fees));
                CTransferArray[i].exports[j].transfers[k].secondreserveid = CTransferArray[i].exports[j].transfers[k].secondreserveid ?
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].secondreserveid) :
                    "0x0000000000000000000000000000000000000000"; //dummy value never read if not set as flags will not read.
                if (CTransferArray[i].exports[j].transfers[k].via) {
                    CTransferArray[i].exports[j].transfers[k].via =
                        util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].via);
                }
            }
        }
    }
    return CTransferArray;
}

function fixETHObjects(inputArray) {

    for (let i = 0; i < inputArray.length; i++) {

        let keys = Object.keys(inputArray[i].currencyvalues);

        for (var key of keys) {
            inputArray[i].currencyvalue = { "currency": key, "amount": inputArray[i].currencyvalues[key] };
        }
        delete inputArray[i].currencyvalues;

        inputArray[i].destination.destinationaddress = inputArray[i].destination.address
        inputArray[i].destination.destinationtype = inputArray[i].destination.type

        delete inputArray[i].destination.address;
        delete inputArray[i].destination.type;
        if ((parseInt(inputArray[i].flags) & 1024) == 1024) { // RESERVETORESERVE FLAG
            inputArray[i].destcurrencyid = inputArray[i].via;
            inputArray[i].secondreserveid = inputArray[i].destinationcurrencyid;
        } else {
            inputArray[i].destcurrencyid = inputArray[i].destinationcurrencyid;
        }
        delete inputArray[i].destinationcurrencyid;

        inputArray[i].destsystemid = inputArray[i].exportto;
        delete inputArray[i].exportto;


    }

    return inputArray;
}

function reshapeTransfers(CTransferArray) {
    let CTempArray = [];

    for (let i = 0; i < CTransferArray.length; i++) {
        for (let j = 0; j < CTransferArray[i].exports.length; j++) {

            const transfers = fixETHObjects(CTransferArray[i].exports[j].transfers);
            const serializedTransfers = serializeCReserveTransfers(transfers);
            if (i == -1)
                console.log("Serialized transfers: 0x", serializedTransfers.toString('hex'));
           // let exportinfo = createCrossChainExportToETH(transfers);

            let subarray = {
                height: 1,
                txid: CTransferArray[i].exports[j].txid,
                txoutnum: CTransferArray[i].exports[j].txoutnum,
              //  exportinfo,
                partialtransactionproof: [CTransferArray[i].exports[j].partialtransactionproof],
                transfers: CTransferArray[i].exports[j].transfers,
                serializedTransfers: addHexPrefix(serializedTransfers.toString('hex'))
            };

            CTempArray.push(subarray);

            if (InteractorConfig.debug) {
                //let hashtest = ethersUtils.keccak2566(serializedTransfers);
                //console.log("Transfers hash: ", hashtest.toString('hex'));
            }
        }
    }

    return CTempArray;
}

exports.submitImports = async(CTransferArray) => {

    if (noaccount || InteractorConfig.noimports || InteractorConfig.spendDisabled) {
        log("************** Submitimports: Wallet will not spend ********************");
        return { result: { error: true } };
    }

    CTransferArray = conditionSubmitImports(CTransferArray);

    let CTempArray = reshapeTransfers(CTransferArray);

    CTempArray = deserializer.deSerializeMMR(CTempArray);

    CTempArray = deserializer.insertHeights(CTempArray);

    let submitArray = [];
    if (InteractorConfig.debugsubmit)
        console.log(JSON.stringify(CTempArray, null, 2))

    try {

        if (CTempArray.length > 0) {
            let processed = await delegatorContract.methods.checkImport(CTempArray[0].txid).call();
            if (!processed) {
                submitArray.push(CTempArray[0])
            } else {
                log("SubmitImports: Import already processed, skipping...");
                return { result: globalsubmitimports.transactionHash };
            }
        } else {
            log("SubmitImports: No imports to submit.");
            return { result: globalsubmitimports.transactionHash };
        }
        // catch any errors and return
        const testcall = await delegatorContract.methods.submitImports(submitArray[0]).call(); //test call
        // prevent revert if gas limit is exceeded
        const gascalc = await delegatorContract.methods.submitImports(submitArray[0]).estimateGas({ from: account.address });

        log("Submitting transfers to ETH, total: " + CTempArray[0].transfers.length);

        const pendingTransactions = await web3.eth.getBlock('pending', true);
        let found = false;
    
        for (const tx of pendingTransactions.transactions) {
            if(tx.to == settings.delegatorcontractaddress) {
                found = true;
                break;
            }
        };
        
        if(found) {
            log("Submitimports: Pending transaction found, skipping...");
        } else if (submitArray.length > 0 && (parseInt(gascalc) < parseInt(submitImportMaxGas))) {
            // Get median gas price from the last block's transactions
            log("Calculating Median Gas Price for submitImports...");
            const gasPrice = await getMedianGasPrice();
            log("Using gas price: " + gasPrice);
            globalsubmitimports = await delegatorContract.methods.submitImports(submitArray[0]).send({ 
                from: account.address, 
                gas: submitImportMaxGas,
                gasPrice: gasPrice
            });
            log("submitImports: success");
            // if the submit import spend  succeeds then we can cache the last submit import.
            await setCachedApi(CTransferArray, 'lastsubmitImports');
        } else {
            log("GAS LIMIT EXCEEDED: " + gascalc + " > " + submitImportMaxGas);
            return { result: {error: true} };
        }
    } catch (error) {

        if (error.reason)
            console.log( "submitImports:" + error.reason);
        else {
            if (error.receipt)
                console.log( "submitImports:" + error.receipt);

            console.log( "submitImports:" + (error?.message ? error.message : error));
        }
        return { result: { result: error.message, error: true } };
    }

    return { result: globalsubmitimports.transactionHash };
}

exports.submitAcceptedNotarization = async(params) => {

    if (noaccount || InteractorConfig.spendDisabled) {
        log("************** submitAcceptedNotarization: Wallet will not spend ********************");
        return { result: { error: true } };
    }

    if (InteractorConfig.debugnotarization) {
        console.log(JSON.stringify(params[0], null, 2));
        console.log(JSON.stringify(params[1], null, 2));
    }

    const serializednotarization = notarization.serializeNotarization(params[0]);

    let signatures = {};

    for (const sigObj of params[1].evidence.chainobjects) {
        if(sigObj.vdxftype == "iP1QT5ee7EP63WSrfjiMFc1dVJVSAy85cT") //vrsc::system.notarization.signature vdxfid
        {
            let sigKeys = Object.keys(sigObj.value.signatures);
            for (let i = 0; i < sigKeys.length; i++) {
                signatures[sigKeys[i]] = sigObj.value.signatures[sigKeys[i]];
            }
        }
    }

    if (Object.keys(signatures).length < 1) {
        log("submitAcceptedNotarization: Not enough signatures.");
        return { "result": { "txid": null, "error": true } };
    }

    let txidObj = params[1].output;
    const lastTxid = await getCachedApi('lastNotarizationTxid');

    try {

        if (lastTxid && lastTxid == JSON.stringify(txidObj.txid)) {
            return { "result": "0" };
        }

    } catch (error) {
        console.log("submitAcceptedNotarization Error:\n", error.message);
        return null;
    }

    const abiencodedSigData = util.encodeSignatures(signatures);
    const txid = addHexPrefix(txidObj.txid.reversebytes())
    let txhash
    try {
        if (InteractorConfig.debugnotarization) {
            console.log(JSON.stringify({serializednotarization, txid, voutnum: txidObj.voutnum, abiencodedSigData}, null, 2));

        }
        // Call contract to test for reversion.
        const testValue = await delegatorContract.methods.setLatestData(serializednotarization, txid, txidObj.voutnum, abiencodedSigData).call();

        const pendingTransactions = await web3.eth.getBlock('pending', true);
        let found = false;

        for (const tx of pendingTransactions.transactions) {
            if(tx.to == settings.delegatorcontractaddress) {
                found = true;
                break;
            }
        };

        if(found) {
            log("Submitacceptednotarization: Pending transaction found, skipping...");
        } else {
            // Get median gas price from the last block's transactions
            const gasPrice = await getMedianGasPrice();
            
            txhash = await delegatorContract.methods.setLatestData(serializednotarization, txid, txidObj.voutnum, abiencodedSigData).send({ 
                from: account.address, 
                gas: notarizationMaxGas,
                gasPrice: gasPrice
            });
            log("notarization tx: success");
        }
        await setCachedApi(txidObj.txid, 'lastNotarizationTxid');
        return { "result": txhash };

    } catch (error) {

        if (error.message == "Returned error: submitAcceptedNotarization execution reverted") {
            console.log("Returned error: execution reverted");
        }
        else if (error.message == "Returned error: execution reverted") {
            console.log(`Notarization reverted... ${params[0].isdefinition ? "Chain definition skipping.." : ""}`);
        }
        else if (error.reason) {
            console.log( "submitAcceptedNotarization:" + error.reason);
        }
        else if (error.message && error.message == "Returned error: already known") {
            console.log("Notarization already Submitted, transaction cancelled");
        }
        else {
            console.log(error.message);
        }
        return { "result": { "error" : true } };
    }
}

//return the data required for a notarisation to be made
exports.getLastImportFrom = async() => {

    //create a CProofRoot from the block data
    let cachelastImportFrom = await getCachedImport('lastImportFrom');
    let lastImportFrom = cachelastImportFrom ? JSON.parse(cachelastImportFrom) : null;

    try {
        var d = new Date();
        var timenow = d.getTime();
        if (globaltimedelta + globalgetlastimport < timenow || !lastImportFrom) {
            globalgetlastimport = timenow;

            //todo: move to constants
            const SUBMIT_IMPORTS_LAST_TXID = "0x00000000000000000000000037256eef64a0bf17344bcb0cbfcde4bea6746347";
            let lastimporttxid = SUBMIT_IMPORTS_LAST_TXID;
            let lastImportInfo;

            // if Main testnet use call to get last import txid
            if (delegatorContract._address === "0x85a7dE2278E52327471e174AeeB280cdFdC6A68a") {
                lastimporttxid = await delegatorContract.methods.lastTxIdImport().call();
            }

            lastImportInfo = await delegatorContract.methods.lastImportInfo(lastimporttxid).call();
            await setCachedImport(lastImportInfo, 'lastImportInfo');

            let lastimport = {};

            lastimport.version = constants.LIF.VERSION;
            lastimport.flags = constants.LIF.FLAGS;
            lastimport.sourcesystemid = InteractorConfig.ethSystemId;
            lastimport.sourceheight = parseInt(lastImportInfo.height);
            lastimport.importcurrencyid = InteractorConfig.ethSystemId;
            lastimport.valuein = {};
            lastimport.tokensout = {};
            lastimport.numoutputs = {};

            lastimport.hashtransfers  = util.removeHexLeader(lastImportInfo.hashOfTransfers).reversebytes();
            lastimport.exporttxid = util.removeHexLeader(lastImportInfo.exporttxid).reversebytes();
            lastimport.exporttxout = lastImportInfo.exporttxoutnum;

            let forksData = {};
            let lastconfirmednotarization = {};
            let lastconfirmedutxo = {};
            try {
                forksData = await delegatorContract.methods.bestForks(0).call();
                forksData = util.removeHexLeader(forksData);

                const lengthMod = forksData.length % constants.LIF.FORKLEN;

                let txidPos = constants.LIF.TXIDPOS;
                let nPos = lengthMod === 0 ? constants.LIF.NPOS : constants.LIF.NPOS_VRSCTEST;
                let txid = "0x" + forksData.substring(txidPos, txidPos + constants.LIF.BYTES32SIZE).reversebytes();
                let n = parseInt(forksData.substring(nPos, nPos + 8), constants.LIF.HEX);

                lastconfirmedutxo = { txid: util.removeHexLeader(txid), voutnum: n }

            } catch (e) {
                console.log( "No Notarizations received yet");
            }
            lastImportFrom = { "result": { lastimport, lastconfirmednotarization, lastconfirmedutxo } }
            await setCachedImport(lastImportFrom, 'lastImportFrom');
        }

        return lastImportFrom;
    } catch (error) {
        console.log( "getLastImportFrom:" + error.message);
        return { "result": { "error": true, "message": error.message } };
    }

}

exports.getclaimablefees = async(params) => {

    const address = params[0];

    if (!address || address.slice(0,2) != "0x" || address.length != 42 ) {

        return { "result": { "error": true, "message": "Not a valid ETH address provided" } };
    }

    const formattedAddress = `0x${web3.utils.padLeft(`0c14${address.slice(2)}`, 64)}`
    const feesSats = await delegatorContract.methods.claimableFees(formattedAddress).call();
    const fees = util.uint64ToVerusFloat(feesSats);

    return { "result": { ETH: {[address]: fees }},  };

}

exports.revokeidentity = async(params) => {

    const TYPE_AUTO_REVOKE = "0x04";
    let txhash
    try {
        const testValue = await delegatorContract.methods.revokeWithMainAddress(TYPE_AUTO_REVOKE).call();
        txhash = await delegatorContract.methods.revokeWithMainAddress(TYPE_AUTO_REVOKE).send({ from: account.address, gas: notarizationMaxGas });

        return { "result": txhash };

    } catch (error) {

        return { "result": { "error": true } };
    }
}

exports.stop = async() => {
    console.log("Stopping bridgekeeper via RPC...");
    await disconnectProviderSocket();

    setTimeout(() => {
        console.log("Shutting down bridgekeeper server...");
        process.exit(0);
    }, 500);

    return { "result": `Bridgekeeper server stopping` };
}

exports.invalid = async() => {
    console.log( "Invalid API call");
    return { "result": { "error": true, "message": "Unrecognized API call" } }

}