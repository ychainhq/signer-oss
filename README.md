# chain-api Community Signer (OSS)

Open-source external signing daemon for the chain-api platform.

## Quick Start

```bash
cp .env.example .env
# Edit .env: set CHAIN_API_BASE_URL, SIGNER_API_KEY, TENANT_ID, SIGNER_ID
# For dev: set BTC_DEV_PRIVATE_KEY_WIF to a testnet/regtest WIF key

npm install
npm run dev
```

## Docker

```bash
cp .env.example .env
# Edit .env

docker compose up -d
docker compose logs -f
```

## Configuration

All configuration via environment variables. See `.env.example` for all options.

Key variables:
- `CHAIN_API_BASE_URL` — URL of your chain-api instance
- `SIGNER_API_KEY` — Tenant API key
- `TENANT_ID` — Your tenant ID
- `SIGNER_ID` — Unique signer ID (e.g. `signer_prod_1`)
- `BTC_DEV_PRIVATE_KEY_WIF` — **Dev only** WIF private key. Never use mainnet keys in env vars.

## Capabilities

- BTC PSBT signing (bitcoinjs-lib)
- Auto-enrollment on startup
- Heartbeat every 30s
- Configurable polling interval
- Local audit log (stdout + file)
- Graceful shutdown on SIGTERM/SIGINT

## Security Notes

- This is a **community** signer. Do not use with large production funds without additional safeguards.
- Recommended maximum: `MAX_AUTO_SIGN_AMOUNT_SATS=1000000` (0.01 BTC)
- For production: use `BTC_SIGNING_MODE=keystore_file` with an encrypted keystore
- For bank-grade: use the Enterprise Signer with HSM/KMS/Vault integration

## Limitations

- No mTLS (plain HTTPS only)
- No HSM/KMS integration
- No quorum approval
- No HA deployment
- No SIEM audit sink

For enterprise requirements, use the chain-api Enterprise Signer.
