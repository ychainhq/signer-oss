# Signer OSS — Key Setup Scripts

Scripts for generating and configuring signing keys for the chain-api OSS Signer (BTC and TRON).

Full setup instructions:
- Polish: [docs/key-setup-pl.md](../docs/key-setup-pl.md)
- English: [docs/key-setup-en.md](../docs/key-setup-en.md)

## Directory structure

```
setup/
├── airgapped/          # MUST run on an offline, air-gapped machine
│   ├── 01-generate-keys.mjs     # Generate xpub/xprv and hot wallet WIF/address
│   ├── 02-verify-keypair.mjs    # Verify xpub and xprv are a matching pair
│   └── 03-create-keystore.mjs   # Encrypt keys into keystore.json
└── online/             # Safe to run on the signer server
    └── 04-verify-keystore.mjs   # Verify keystore loads correctly (no key export)
```

## Quick reference

Run all scripts from the `signer-oss/` directory.

### Air-gapped machine

```bash
# 1. Generate both keys
NETWORK=mainnet node setup/airgapped/01-generate-keys.mjs

# 2. Verify xpub/xprv are a pair
XPUB="xpub6D..." XPRV="xprv9..." NETWORK=mainnet node setup/airgapped/02-verify-keypair.mjs

# 3. Create encrypted keystore
KEYSTORE_PASSWORD='...' \
XPRV='xprv9...' \
HD_FINGERPRINT='btc_hd:mainnet:aabbccdd' \
WIF='K...' \
HOT_FINGERPRINT='btc:mainnet:11223344' \
NETWORK=mainnet \
node setup/airgapped/03-create-keystore.mjs
```

### Signer server

```bash
# 4. Verify keystore after transfer
BTC_KEYSTORE_PATH=./data/keystore.json \
KEYSTORE_PASSWORD='...' \
EXPECTED_FINGERPRINT='btc:mainnet:11223344' \
EXPECTED_FINGERPRINT_HD='btc_hd:mainnet:aabbccdd' \
node setup/online/04-verify-keystore.mjs
```

## TRON key setup (mainnet)

TRON keys are loaded via environment variables — there is no encrypted keystore file for TRON (unlike BTC). For production, inject keys through a secrets manager (k8s Secret, Vault Agent sidecar, AWS Secrets Manager, etc.) — never write them to a `.env` file on disk.

### Air-gapped: generate TRON withdrawal key (hot wallet)

```bash
# On an offline machine with node_modules/ available:
node -e "
const { ec: EC } = require('elliptic');
const crypto = require('crypto');
const ec = new EC('secp256k1');
const key = ec.genKeyPair();
const priv = key.getPrivate('hex').padStart(64, '0');
const pub = key.getPublic(false, 'hex');
// TRON address (base58check) derivation requires keccak256 — use tronweb or manual derivation
console.log('TRON_DEV_PRIVATE_KEY_HEX=' + priv);
console.log('NOTE: derive TRON address from this key using TronWeb.address.fromPrivateKey()');
"
# Write TRON_DEV_PRIVATE_KEY_HEX to an encrypted offline file.
# Transfer to signer server via a secrets manager — NOT by copying the .env file.
```

### Air-gapped: generate TRON sweep HD key (BIP32, SLIP44 coin_type=195)

```bash
# Requires: bip39, bip32, tiny-secp256k1 in node_modules
node -e "
const { BIP32Factory } = require('bip32');
const ecc = require('tiny-secp256k1');
const bip39 = require('bip39');
const factory = BIP32Factory(ecc);
// Generate 24-word mnemonic (256-bit entropy)
const mnemonic = bip39.generateMnemonic(256);
const seed = bip39.mnemonicToSeedSync(mnemonic);
const root = factory.fromSeed(seed);
// m/44'/195'/0' — account-level xprv, SLIP44 coin_type=195 (TRON)
const account = root.derivePath(\"m/44'/195'/0'\");
console.log('MNEMONIC (PAPER BACKUP ONLY):', mnemonic);
console.log('TRON_ACCOUNT_XPUB:', account.neutered().toBase58());
console.log('TRON_DEV_ACCOUNT_XPRV (SECRET):', account.toBase58());
"
# MNEMONIC: write on paper, store in a fireproof safe offline.
# TRON_DEV_ACCOUNT_XPRV: inject into signer via secrets manager.
# TRON_ACCOUNT_XPUB: register in engine tenant_configs (for address derivation).
```

### Required `.env` for TRON mainnet

```bash
# Enable TRON in this signer
SUPPORTED_CHAINS=bitcoin,tron

# TRON withdrawal key (hot wallet) — inject via k8s Secret / Vault Agent
TRON_DEV_PRIVATE_KEY_HEX=<64-char hex>
TRON_SIGNER_FINGERPRINT=tron:mainnet:AABBCCDD   # 8 hex chars from hot wallet address

# TRON sweep HD key — inject via secrets manager
TRON_DEV_ACCOUNT_XPRV=xprv9...
TRON_SIGNER_FINGERPRINT_HD=tron_hd:mainnet:EEFF0011

# TRON policy — MUST be set for mainnet
TRON_NETWORK=mainnet
TRON_ALLOWED_CONTRACTS=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t
MAX_TRON_AMOUNT_SUN=100000000000
MAX_TRON_FEE_LIMIT_SUN=50000000
```

Full production setup guide (nodes, indexer, engine, multi-node):
[docs/tron-mainnet-production-setup.md](../../docs/tron-mainnet-production-setup.md)

## Security notes

- Scripts in `airgapped/` handle private key material and must never run on a networked machine.
- Scripts in `online/` only decrypt to verify — they never print private keys.
- Pass `KEYSTORE_PASSWORD` via environment variable, never as a command-line argument.
- Store `keystore.json` and its password in separate locations.
- TRON keys have no keystore file — protect them exclusively through your secrets manager (k8s Secrets, Vault Agent, AWS SM, etc.).
- `TRON_NETWORK=mainnet` and a non-empty `TRON_ALLOWED_CONTRACTS` are mandatory for mainnet — the defaults (`private`, empty) would silently accept any TRON network/contract.
