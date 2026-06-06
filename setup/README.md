# BTC Signer Key Setup Scripts

Scripts for generating and configuring BTC signing keys for the chain-api OSS Signer.

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

## Security notes

- Scripts in `airgapped/` handle private key material and must never run on a networked machine.
- Scripts in `online/` only decrypt to verify — they never print private keys.
- Pass `KEYSTORE_PASSWORD` via environment variable, never as a command-line argument.
- Store `keystore.json` and its password in separate locations.
