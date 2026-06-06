# BTC Signer Key Setup — Client Environment Guide

## Table of Contents

1. [What You Need and Why](#1-what-you-need-and-why)
2. [Prerequisites](#2-prerequisites)
3. [Step 1 — Prepare an Air-Gapped Machine](#step-1--prepare-an-air-gapped-machine)
4. [Step 2 — Generate Both Keys](#step-2--generate-both-keys)
5. [Step 3 — Verify the xpub/xprv Pair](#step-3--verify-the-xpubxprv-pair)
6. [Step 4 — Create the Encrypted Keystore](#step-4--create-the-encrypted-keystore)
7. [Step 5 — Transfer the Keystore to the Signer Server](#step-5--transfer-the-keystore-to-the-signer-server)
8. [Step 6 — Verify the Keystore on the Server](#step-6--verify-the-keystore-on-the-server)
9. [Step 7 — Configure the Engine](#step-7--configure-the-engine)
10. [Step 8 — Configure the Signer `.env`](#step-8--configure-the-signer-env)
11. [Step 9 — Start the Signer](#step-9--start-the-signer)
12. [Configuration Dependency Map](#configuration-dependency-map)
13. [What Happens When Keys Do Not Match](#what-happens-when-keys-do-not-match)

---

## 1. What You Need and Why

You need exactly **two independent secrets**, generated separately and stored separately.

### Secret A — HD Account Key

A hierarchical key at the BIP-44 account node level (derivation path: `m/44'/{coinType}'/0'`). HD stands for _Hierarchical Deterministic_ — from a single seed you can deterministically derive an unlimited number of child keys, one per customer deposit address.

You need two values from this secret:

- **`xprv`** — the private key at the account node level. Goes exclusively into the signer keystore. The signer uses it to derive a child key for each PSBT input during a sweep.
- **`xpub`** — the corresponding public key. Goes into the engine (`tenant_configs.btc_xpub`). The engine only knows the public key — it uses it to embed derivation paths into the PSBT but cannot sign with it.

### Secret B — Hot Wallet Key

A single private key for the hot wallet. The signer uses it to sign withdrawal batches — all UTXOs in a batch come from one hot wallet address, so a single key is sufficient.

You need two values from this secret:

- **WIF** (Wallet Import Format) — the private key in the format used by the signer. Goes into the signer keystore.
- **Bitcoin address** — the public address corresponding to this key. Registered in the engine as the tenant's hot wallet address.

### Why Two Separate Secrets

Compromising the hot wallet key does not expose the customer deposit address keys and vice versa. Using a single secret for both purposes would mean a single security incident compromises the entire system.

---

## 2. Prerequisites

**On the air-gapped machine (key generation):**

- Node.js 20+
- The `signer-oss/` directory from the project with dependencies installed (`node_modules/`). Copy via USB before disconnecting from the network.

**On the signer server:**

- Node.js 20+
- Compiled or source `signer-oss/` directory
- Access to a secrets manager (HashiCorp Vault, AWS Secrets Manager, 1Password Teams, or similar) for storing the keystore password

**General:**

- A keystore encryption password — minimum 24 characters, randomly generated. Generate it with `openssl rand -base64 32` and store it in your secrets manager **before** starting the process.

---

## Step 1 — Prepare an Air-Gapped Machine

Disable WiFi and unplug the network cable. If using a virtual machine, disable the network adapter in the hypervisor settings. Private keys should never be generated on a machine connected to the internet.

Copy the `signer-oss/` directory to the machine via USB — including `node_modules/` so that npm network access is not required.

Open a terminal and navigate to the `signer-oss/` directory:

```bash
cd signer-oss
```

Run all scripts below from this directory.

---

## Step 2 — Generate Both Keys

Run the script `setup/airgapped/01-generate-keys.mjs`:

```bash
NETWORK=mainnet node setup/airgapped/01-generate-keys.mjs
```

Use `NETWORK=testnet` for a test environment or `NETWORK=regtest` for local development.

The script prints six values to stdout. Write them down or save them to a temporary file **on the same machine** — do not send over the network or copy via clipboard to a connected machine.

| Value | Description | Destination |
|-------|-------------|-------------|
| `xpub` | Account node public key | Engine — `tenant_configs.btc_xpub` |
| `xprv` | Account node private key | Signer keystore (Secret A) |
| `HD fingerprint` | 4-byte identifier for the HD key | Part of `SIGNER_FINGERPRINT_HD` |
| `WIF` | Hot wallet private key | Signer keystore (Secret B) |
| `Hot wallet address` | Bitcoin address of the hot wallet | Engine — register as `tenant_hot` |
| `SIGNER_FINGERPRINT` | WIF key identifier in the keystore | Signer `.env` file |
| `SIGNER_FINGERPRINT_HD` | HD key identifier in the keystore | Signer `.env` file |

---

## Step 3 — Verify the xpub/xprv Pair

Before creating the keystore, confirm that the `xpub` and `xprv` from Step 2 are a matching pair — the same BIP32 node, with public and private halves.

```bash
XPUB="xpub6D..." XPRV="xprv9..." NETWORK=mainnet node setup/airgapped/02-verify-keypair.mjs
```

The script:
- Derives the public key from `xprv` and compares it to `xpub` — they must be identical
- Prints the fingerprint and node depth — depth should be 3 (account level at `m/44'/x'/0'`)
- Exits with code `1` if the pair does not match — **do not proceed in that case**

---

## Step 4 — Create the Encrypted Keystore

Encryption uses AES-256-GCM with a key derived via PBKDF2 (100,000 SHA-256 iterations). Each key in the keystore is encrypted separately with a random `salt` and `iv`.

Provide the password and values from Step 2 as environment variables:

```bash
KEYSTORE_PASSWORD='your-strong-password-min-24-chars' \
XPRV='xprv9...' \
HD_FINGERPRINT='btc_hd:mainnet:aabbccdd' \
WIF='K...' \
HOT_FINGERPRINT='btc:mainnet:11223344' \
NETWORK=mainnet \
OUTPUT_PATH=./keystore.json \
node setup/airgapped/03-create-keystore.mjs
```

`HD_FINGERPRINT` and `HOT_FINGERPRINT` are exactly the `SIGNER_FINGERPRINT_HD` and `SIGNER_FINGERPRINT` values from the Step 2 output.

Provide the password as an environment variable, **not as a command-line argument** — arguments end up in shell history.

The script:
- Creates `keystore.json` with `600` permissions (owner read/write only)
- Prints the final `SIGNER_FINGERPRINT` and `SIGNER_FINGERPRINT_HD` values to paste into `.env`

**Store the password in your secrets manager now.** Without it, the keystore is useless and cannot be recovered.

Delete any temporary file containing the key values (if created) and clear the terminal history.

---

## Step 5 — Transfer the Keystore to the Signer Server

Copy `keystore.json` to the signer server via USB or a secure channel (SCP over an internal network, Kubernetes secret mount, etc.).

Place the file at `signer-oss/data/keystore.json` or at the path you will set in `BTC_KEYSTORE_PATH`.

Set permissions:

```bash
chmod 600 ./data/keystore.json
```

`keystore.json` is encrypted and safe to transfer — without the password it is useless. Store the password and the keystore file in **separate locations**.

---

## Step 6 — Verify the Keystore on the Server

On the signer server, run the verification script:

```bash
BTC_KEYSTORE_PATH=./data/keystore.json \
KEYSTORE_PASSWORD='your-password' \
EXPECTED_FINGERPRINT='btc:mainnet:11223344' \
EXPECTED_FINGERPRINT_HD='btc_hd:mainnet:aabbccdd' \
node setup/online/04-verify-keystore.mjs
```

The script decrypts the keystore, prints the loaded fingerprints, and checks whether they match the expected values. It does not output private key material.

Expected output:

```
Decrypting btc:mainnet:11223344 (btc)...       OK
Decrypting btc_hd:mainnet:aabbccdd (btc_hd)... OK

SIGNER_FINGERPRINT=btc:mainnet:11223344       → FOUND ✓
SIGNER_FINGERPRINT_HD=btc_hd:mainnet:aabbccdd → FOUND ✓

Keystore is valid.
```

---

## Step 7 — Configure the Engine

### Set the tenant xpub

The `xpub` value from Step 2 goes into the engine via the admin API:

```http
PATCH /admin/v1/tenants/{tenantId}/config
X-Admin-Key: {ADMIN_KEY}
Content-Type: application/json

{
  "btcXpub": "xpub6D..."
}
```

### Create the hot wallet and register the address

First, create a wallet with the `tenant_hot` role:

```http
POST /v1/wallets
Authorization: Bearer {TENANT_API_KEY}
Content-Type: application/json

{
  "chainId": "bitcoin",
  "role": "tenant_hot",
  "label": "BTC Hot Wallet"
}
```

Then register the address from Step 2 in that wallet:

```http
POST /v1/wallets/{walletId}/addresses
Authorization: Bearer {TENANT_API_KEY}
Content-Type: application/json

{
  "address": "bc1q..."
}
```

---

## Step 8 — Configure the Signer `.env`

Create or populate the `.env` file in the `signer-oss/` directory. The values for `SIGNER_FINGERPRINT`, `SIGNER_FINGERPRINT_HD`, and `BTC_NETWORK` come from the Step 4 output. On production, retrieve the keystore password from your secrets manager at container/process startup — do not store it in `.env` as plaintext on disk.

```env
# ── Identity ────────────────────────────────────────────────────
SIGNER_MODE=community
SIGNER_ID=signer_prod_1
SIGNER_NAME=Prod Signer 1
TENANT_ID=<tenant_id>

# ── Engine connection ───────────────────────────────────────────
CHAIN_API_BASE_URL=https://engine.your-domain.com
SIGNER_API_KEY=<tenant-api-key>

# ── BTC ─────────────────────────────────────────────────────────
BTC_NETWORK=mainnet
SUPPORTED_CHAINS=bitcoin
SUPPORTED_ASSETS=bitcoin:BTC
SUPPORTED_FORMATS=btc_psbt

# ── Keystore ────────────────────────────────────────────────────
BTC_SIGNING_MODE=keystore_file
BTC_KEYSTORE_PATH=./data/keystore.json
BTC_KEYSTORE_PASSWORD=<password-from-secrets-manager>

# ── Fingerprints — values from Step 4 output ───────────────────
SIGNER_FINGERPRINT=btc:mainnet:11223344
SIGNER_FINGERPRINT_HD=btc_hd:mainnet:aabbccdd

# ── Enrollment ──────────────────────────────────────────────────
SIGNER_AUTO_ENROLL=true
SIGNER_PUBLIC_KEY=ed25519:placeholder

# ── Policy ──────────────────────────────────────────────────────
MAX_AUTO_SIGN_AMOUNT_SATS=5000000
MAX_FEE_RATE_SAT_VB=50
MAX_OUTPUTS_PER_BATCH=200
ALLOWED_DESTINATIONS=

# ── Polling ─────────────────────────────────────────────────────
POLL_INTERVAL_MS=5000
TASK_BATCH_SIZE=5

# ── Audit ───────────────────────────────────────────────────────
AUDIT_LOG_FILE=./data/audit.log
AUDIT_STDOUT=true

# ── Status port ─────────────────────────────────────────────────
SIGNER_PORT=3101
SIGNER_BIND_HOST=127.0.0.1
```

---

## Step 9 — Start the Signer

```bash
cd signer-oss
npm run start
```

A successful startup looks like this:

```
[keystore] Key loaded from file: btc:mainnet:11223344 (btc)
[keystore] Key loaded from file: btc_hd:mainnet:aabbccdd (btc_hd)
[signer] Sending heartbeat...
[signer] Status: active
```

Confirm enrollment in the engine:

```http
GET /v1/external-signers
Authorization: Bearer {TENANT_API_KEY}
```

The signer should show `"status": "active"` and `"lastHealthStatus": "healthy"`.

---

## Configuration Dependency Map

```
setup/airgapped/01-generate-keys.mjs
│
├── Secret A (HD account key)
│   ├── xpub ──────────────────────────► tenant_configs.btc_xpub (engine, admin API)
│   ├── xprv ──────────────────────────► keystore.json btc_hd entry (via 03-create-keystore)
│   └── SIGNER_FINGERPRINT_HD ─────────► signer .env + HD_FINGERPRINT for 03-create-keystore
│
└── Secret B (hot wallet key)
    ├── WIF ───────────────────────────► keystore.json btc entry (via 03-create-keystore)
    ├── hotAddress ────────────────────► wallets/{id}/addresses (engine, tenant API)
    └── SIGNER_FINGERPRINT ────────────► signer .env + HOT_FINGERPRINT for 03-create-keystore
```

Pair consistency is validated automatically by Bitcoin Core: if the `xpub` in the engine and the `xprv` in the keystore are not a matching pair, the signer will produce a signature that does not match the UTXO scripts, and `testmempoolaccept` will reject the transaction. No broadcast will occur and no funds will be lost.

---

## What Happens When Keys Do Not Match

| Misconfiguration | Symptom | Stage |
|---|---|---|
| `xpub` and `xprv` are not a pair | Sweep fail: `testmempoolaccept` rejects the transaction | After signing, before broadcast |
| Wrong WIF for hot wallet | Withdrawal batch fail: `testmempoolaccept` rejects | After signing, before broadcast |
| Wrong `SIGNER_FINGERPRINT` in `.env` | Crash on startup: `No WIF key for fingerprint: ...` | Keystore loading |
| Wrong `SIGNER_FINGERPRINT_HD` in `.env` | Crash when signing a sweep: `No HD account xprv for fingerprint: ...` | During task signing |
| Wrong hot wallet address in engine | No UTXOs available for coin selection — batches empty, withdrawal queue grows | Batcher creates no batches |

In none of these cases is there a risk of losing funds — a transaction will not be broadcast without a passing `testmempoolaccept`.
