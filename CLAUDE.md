# chain-api OSS Signer - wytyczne

## Architektura provider-neutral

- OSS signer implementuje ten sam external signer protocol co Enterprise signer. Nie wolno wprowadzac zmian protokolu, ktore wymagaja osobnej sciezki w engine dla OSS albo Enterprise.
- Engine zna tylko signer enrollment, heartbeat, signing tasks, signer responses, fingerprinty i response signing. Engine nie zna providerow kluczy ani sekretow.
- Provider signing/key/secret/policy jest adapterem za interfejsem signera. Dla OSS domyslne adaptery moga byc lokalne/dev, ale musza zachowac kontrakty wspolne z Enterprise.
- Wspolne DTO, zod schemas, payload hashing, polling client i walidacje ida do `../packages/external-signer-protocol` albo `../packages/external-signer-core`.
- Nie dodawaj do OSS logiki biznesowej tenanta, routingu chain nodes ani bezposrednich zaleznosci od bazy engine'u.

## Architektura kluczy TRON

OSS signer przechowuje dwie kategorie kluczy TRON o rozlacznych rolach:

| Klucz | Fingerprint env var | Typ klucza | Rola |
|-------|---------------------|-----------|------|
| Withdrawal | `TRON_SIGNER_FINGERPRINT` | EC secp256k1 private key | Hot wallet — podpisywanie wyplat klientow |
| Sweep HD | `TRON_SIGNER_FINGERPRINT_HD` | BIP32 HD xprv, SLIP44 coin_type=195 | Klucze per-depozyt: derywacja m/0/N |

**SR key (localwitness)** — klucz blokowy Super Representative, konfigurowany wylacznie w TRON nodzie (`config-node1.conf`). OSS signer nigdy nie widzi ani nie obsluguje SR key.

### Co signer podpisuje

Engine przekazuje `unsignedPayload` z `payloadFormat=tron_raw_tx`. Signer wykonuje kolejno:

1. Integralnosc: `sha256(unsignedPayload) === unsignedPayloadHash` (z task envelope)
2. Polityka: `assertTronTxTaskValid` — allowlist sieci i kontraktow TRC-20, limity kwoty/fee_limit, walidacja sciezki derywacji
3. Format: `txIdBytes.length === 32`
4. Podpisywanie: `signRecoverable(txIdBytes, privKey)` → 65 bajtow (64B sig + 1B recovery ID) → 130 hex chars

`txID` = sha256(raw_data), budowane przez TRON FullNode przez `/wallet/triggersmartcontract`. Signer weryfikuje txID, nie recalculates raw_data.

### Signing requestTypes TRON

| requestType | Klucz | payloadFormat | Opis |
|---|---|---|---|
| `tron_withdrawal` | Hot wallet (withdrawal) | `tron_raw_tx` | Wyplata klienta — USDT lub TRX |
| `tron_sweep` | HD xprv (m/0/N) | `tron_raw_tx` | Sweep USDT (TRC-20) z adresu depozytowego |
| `tron_trx_sweep` | HD xprv (m/0/N) | `tron_raw_tx` | Sweep natywnego TRX z adresu depozytowego |
| `tron_delegate_energy` | Hot wallet (withdrawal) | `tron_raw_tx` | Stake 2.0: deleguje ENERGY do adresu przed USDT sweep |
| `tron_undelegate_energy` | Hot wallet (withdrawal) | `tron_raw_tx` | Reclaim delegowanej ENERGY po sweepie |

HD routing: jesli task.requestType === 'tron_sweep' lub 'tron_trx_sweep' I payload.derivationPath jest ustawiony → HD child key. Pozostale → hot wallet key.

### Weryfikacja polityki (`assertTronTxTaskValid`)

- Allowlist dozwolonych sieci (mainnet / shasta / nile / privatenet)
- Allowlist adresow kontraktow TRC-20 (np. adres USDT na mainnet)
- Limit `amount` — gorny pulap kwoty transferu per task
- Limit `fee_limit` — gorny pulap energii/bandwidth per task
- Dla sweep HD: format sciezki `m/0/N`, zakres indeksu N
- `hotWalletAddress` — weryfikuje `ownerAddress` w delegation tasks
- `maxStakedEnergySun` — cap na `balanceSun` w delegation tasks (domyslnie 100 TRX = 100_000_000 sun)

### Zmienne konfiguracyjne OSS (TRON)

| Zmienna | Typ | Opis |
|---|---|---|
| `TRON_DEV_ACCOUNT_XPRV` | string | HD xprv dla sweep kluczy (m/0/N) |
| `TRON_SIGNER_FINGERPRINT` | string | Fingerprint withdrawal key (hot wallet) |
| `TRON_SIGNER_FINGERPRINT_HD` | string | Fingerprint HD sweep key |
| `TRON_DEV_HOT_ADDRESS` | string? | Adres hot wallet TRON (ustawiany przez seed.ts w dev) |
| `MAX_TRON_STAKED_ENERGY_SUN` | bigint | Cap dla delegation balanceSun (domyslnie 100_000_000 = 100 TRX) |

`TRON_DEV_HOT_ADDRESS` musi odpowiadac adresowi TRON hot wallet key. W produkcji ustaw jako `HOT_WALLET_TRON_ADDRESS`.

### Reguly implementacyjne

- `signRecoverable` (nie `sign`) — TRON wymaga EC recoverable signature do weryfikacji na chain
- Withdrawal key: bezposredni private key, bez HD derywacji
- Sweep key: HD child key `m/0/N`, gdzie N = `derivationIndex` z task payload, SLIP44 coin_type=195
- OSS provider: klucze lokalne (dev/test), np. z pliku lub env var — nie Vault/KMS/HSM (to Enterprise)
- Klucze nigdy nie trafiaja do logow ani odpowiedzi protokolu
- Interfejsy i walidacje wspolne z Enterprise ida do `../packages/external-signer-protocol`

## Docker i release

- Publiczny obraz Docker Hub: `chain-api-signer-oss`.
- Workflow buduje obraz z kontekstu workspace zawierajacego `signer-oss/` i sibling `packages/`, bo Dockerfile uzywa lokalnych pakietow external signer.
