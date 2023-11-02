# Verus Bridgekeeper

Verus Bridgekeeper is a node js application passing transactions between Verus and Ethereum blockchains.

To install Verus Bridgekeeper  complete the following steps:

## Installing NVM, node, yarn & pm2
```shell
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.5/install.sh | bash
# you may need to log out and log back in or source your shell profile at this step
nvm install 18
npm install -g pm2 yarn
```
## Installing the Bridgekeeper
```shell
cd ~
git clone https://github.com/VerusCoin/Verusbridgekeeper.git
cd ~/Verusbridgekeeper
yarn install
```
Then after the installation run the following to create the initial configuration file
```shell
yarn start
```
It will exit with an error after creating a template configuration file for you to edit/populate.
#### In *.conf set:
delegatorcontractaddress= The bridge delegator contract address provided after the contracts have been launched

ethnode=wss:// to a websocket address for an Ethereum node

Only for witnesses:

privatekey= the private key (in hex, no leading 0x) of an ethereum account on the mainnet (goerli on testnet) chain with sufficient funds, to provide gas for calls to the contracts.
```
(mainnet)
Apple: /Library/Application Support/Verus/pbaas/52c7a71ed15802d33778235e7988d61339b84c45/52c7a71ed15802d33778235e7988d61339b84c45.conf
Linux: ~/.verus/pbaas/52c7a71ed15802d33778235e7988d61339b84c45/52c7a71ed15802d33778235e7988d61339b84c45.conf
Windows: %appdata%\Verus\pbaas\52c7a71ed15802d33778235e7988d61339b84c45\52c7a71ed15802d33778235e7988d61339b84c45.conf

(testnet)
Apple: /Library/Application Support/Verustest/pbaas/000b090bec6c9ff28586eb7ed24e77562f0c4667/000b090bec6c9ff28586eb7ed24e77562f0c4667.conf
Linux: ~/.verustest/pbaas/000b090bec6c9ff28586eb7ed24e77562f0c4667/000b090bec6c9ff28586eb7ed24e77562f0c4667.conf
Windows: %appdata%\Verustest\pbaas\000b090bec6c9ff28586eb7ed24e77562f0c4667\000b090bec6c9ff28586eb7ed24e77562f0c4667.conf
```
To set the wallet not to spend (but still enable revoke) please edit the above *.conf file and add:
```ini
nowitnesssubmissions=true
```


### Running the bridgekeeper on the console:

The following command will start the bridgekeeper from the command line 

```shell
yarn start -log [-debug] [-debugnotarization] [-testnet]
```

```
Optional flags:

-debug                Shows extra information
-debugnotarization    Shows debug information
-testnet              Runs the Bridgekeeper for the Verus testnet
```

### Running the bridgekeeper in PM2:
```shell
cd ~/Verusbridgekeeper;  pm2 start start.js --name bridgekeeper -- -consolelog
```
or create a shell script (in `~/bin`) for convenient starting and start that using `~/bin/startbridge.sh`:
```
cat << EOF > ~/bin/startbridge.sh
#!/bin/bash
cd ~/Verusbridgekeeper;  pm2 start start.js --name bridgekeeper -- -consolelog
EOF
chmod +x ~/bin/startbridge.sh
```
When using PM2, console logs are stored in `~/.pm2/logs/bridgekeeper-out.log` and the errors in `~/.pm2/logs/bridgekeeper-error.log`

This will result in the service running on port 8002 it can be queried using the following examples:
```shell
curl -u <yourusername>:<yourpassword> --data-binary '{"jsonrpc":"1.0","id":"curltext","method":"getinfo","params":[]}' -H 'content-type:text/plain;' http://127.0.0.1:8002

curl -u <yourusername>:<yourpassword> --data-binary '{"jsonrpc":"1.0","id":"curltext","method":"getcurrency","params":["iCtawpxUiCc2sEupt7Z4u8SDAncGZpgSKm"]}' -H 'content-type:text/plain;' http://127.0.0.1:8002
```
Please check in the config file above for `<yourusername>`, `<yourpassword>` and the portnumber that is configured and use those details in the above test calls.

## Optional: logrotate with PM2
As root user, create a file called /etc/logrotate.d/verusd-rpc with these contents:
```shell
/home/verus/.komodo/VRSC/debug.log
/home/verusd-rpc/.pm2/logs/verusbridge-out.log
/home/verusd-rpc/.pm2/logs/verusbridge-error.log
{
  rotate 14
  daily
  compress
  delaycompress
  copytruncate
  missingok
  notifempty
}
```
=======
#Updgrading contracts utility

Run `yarn run getcontracthash`  from the main directory.

## Using the Verus Utilities to revoke and recover addresses.

In the /utiliites folder there is a file called upgrade.js .  It handles contract upgrades and also revoking
and recovering identities.  For it to be able to revoke it needs to be able to interact with the contract
and send a transaction using the notaries main key.


### To revoke

Your private key in you veth pbaas conf file should be your main spend address.

```shell
node upgrade.js -revoke
```

### To recover to a new main address / recover address

Setup a connection between the utility and the verus daemon.  The daemon needs to have the R address in its wallet for the current
recovery address in the notary setup on Ethereum. (The utility will look in the verus.conf file for the RPC connection details).
e.g. in `/.komodo/VRSC/VRSC.conf`

```shell
node upgrade.js -recover 'notaries i-address' 'ETH address of main signer' 'ETH address of recover' 'R-address of current ETH recovery' [-testnet]
```
e.g.
`node upgrade.js -recover iKjrTCwoPFRk44fAi2nYNbPG16ZUQjv1NB 0xD3258AD271066B7a780C68e527A6ee69ecA15b7F 0x68f56bA248E23b7d5DE4Def67592a1366431d345 RH7h8p9LN2Yb48SkxzNQ29c1Ltfju8Cd5i`


## Multisig revoke and recover

For the notaries, a quorum is required to revoke or recover another notary. The notaries first have to agree on the new notaries signing and recover ETH addresses.

Once they are decided each notary can make a packet of information that when put together it makes a upgrade script that the contract can accept and upgrade.

(see recovermutisig.json and revokemultisig.json for examples)

## To make the revoke data

```shell
node upgrade.js -createmultisigrevoke 'your notaries i-address' 'notary to be revoked' 'R-address of your notaries primary key' [-testnet]
```
e.g.
```shell
node upgrade.js -createmultisigrevoke iKjrTCwoPFRk44fAi2nYNbPG16ZUQjv1NB iChhvvuUPn7xh41tW91Aq29ah9FNPRufnJ RLXCv2dQPB4NPqKUweFx4Ua5ZRPFfN2F6D
```

## To make the recover data

```shell
node upgrade.js -createmultisigrecover 'your notaries i-address' 'notary to be revoked' 'R-address of your notaries recovery' 'notaries new main ETH address' 'notaries new recovery ETH address' [-testnet]
```
e.g.
```shell
node upgrade.js -createmultisigrecover iKjrTCwoPFRk44fAi2nYNbPG16ZUQjv1NB iChhvvuUPn7xh41tW91Aq29ah9FNPRufnJ REXBEDfAz9eJMCxdexa5GnWQBAax8hwuiu 0x68f56bA248E23b7d5DE4Def67592a1366431d345 0xD010dEBcBf4183188B00cafd8902e34a2C1E9f41
```
## To revoke an address with multisig

As above there needs to be a connection from the utility to a verus daemon running with the R address that can sign
for the notaries recover key.

```shell
node upgrade.js -revokemultisig [-testnet]
```


## To recover an address with multisig

As above there needs to be a connection from the utility to a verus daemon running with the R address that can sign
for the notaries recover key.

```shell
node upgrade.js -recovermultisig [-testnet]
```
