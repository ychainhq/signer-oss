# Konfiguracja kluczy BTC Signer — instrukcja dla środowiska klienta

## Spis treści

1. [Co potrzebujesz i dlaczego](#1-co-potrzebujesz-i-dlaczego)
2. [Prereqyizyty](#2-prereqyizyty)
3. [Krok 1 — Przygotuj air-gapped maszynę](#krok-1--przygotuj-air-gapped-maszynę)
4. [Krok 2 — Wygeneruj oba klucze](#krok-2--wygeneruj-oba-klucze)
5. [Krok 3 — Zweryfikuj parę xpub/xprv](#krok-3--zweryfikuj-parę-xpubxprv)
6. [Krok 4 — Utwórz zaszyfrowany keystore](#krok-4--utwórz-zaszyfrowany-keystore)
7. [Krok 5 — Przenieś keystore na serwer signera](#krok-5--przenieś-keystore-na-serwer-signera)
8. [Krok 6 — Zweryfikuj keystore na serwerze](#krok-6--zweryfikuj-keystore-na-serwerze)
9. [Krok 7 — Skonfiguruj silnik (Engine)](#krok-7--skonfiguruj-silnik-engine)
10. [Krok 8 — Skonfiguruj `.env` signera](#krok-8--skonfiguruj-env-signera)
11. [Krok 9 — Uruchom signer](#krok-9--uruchom-signer)
12. [Mapa zależności konfiguracyjnych](#mapa-zależności-konfiguracyjnych)
13. [Co się stanie gdy klucze się nie zgadzają](#co-się-stanie-gdy-klucze-się-nie-zgadzają)

---

## 1. Co potrzebujesz i dlaczego

Do działania systemu potrzebujesz dokładnie **dwóch niezależnych sekretów**, wygenerowanych osobno i przechowywanych osobno.

### Sekret A — HD account key

Klucz hierarchiczny na poziomie account node (ścieżka BIP-44: `m/44'/{coinType}'/0'`). Skrót HD oznacza _Hierarchical Deterministic_ — z jednego nasienia możesz deterministycznie wyprowadzić nieskończenie wiele kluczy potomnych, po jednym dla każdego adresu depozytowego klienta.

Z tego sekretu potrzebujesz dwóch wartości:

- **`xprv`** — klucz prywatny na poziomie account node. Trafia wyłącznie do keystora signera. Signer używa go żeby wyprowadzić child key dla każdego inputu PSBT przy sweepie.
- **`xpub`** — odpowiadający klucz publiczny. Trafia do silnika (`tenant_configs.btc_xpub`). Silnik zna tylko klucz publiczny — używa go do osadzenia ścieżki derywacji w PSBT, ale nie może nim niczego podpisać.

### Sekret B — Hot wallet key

Pojedynczy klucz prywatny hot walleta. Signer używa go do podpisywania withdrawal batchy — wszystkie UTXO wejściowe w batchu pochodzą z jednego adresu hot wallet, więc wystarczy jeden klucz.

Z tego sekretu potrzebujesz:

- **WIF** (Wallet Import Format) — klucz prywatny w formacie gotowym do użycia przez signer. Trafia do keystora signera.
- **Adres Bitcoin** — adres publiczny odpowiadający temu kluczowi. Trafia do silnika jako adres hot wallet tenanta.

### Dlaczego dwa osobne sekrety

Kompromitacja hot wallet key nie daje dostępu do kluczy adresów depozytowych klientów i odwrotnie. Gdybyś użył jednego sekretu dla obu celów, jeden incydent bezpieczeństwa kompromitowałby cały system.

---

## 2. Prereqyizyty

**Na air-gapped maszynie (generowanie kluczy):**

- Node.js 20+
- Katalog `signer-oss/` z projektu wraz z zainstalowanymi zależnościami (`node_modules/`). Skopiuj przez USB przed odłączeniem od sieci.

**Na serwerze signera:**

- Node.js 20+
- Skompilowany lub źródłowy katalog `signer-oss/`
- Dostęp do managera sekretów (HashiCorp Vault, AWS Secrets Manager, 1Password Teams lub inne) do bezpiecznego przechowywania hasła do keystora

**Ogólne:**

- Hasło do szyfrowania keystora — minimum 24 znaki, losowe. Wygeneruj np. przez `openssl rand -base64 32` i zapisz w managerze sekretów **przed** rozpoczęciem procesu.

---

## Krok 1 — Przygotuj air-gapped maszynę

Wyłącz WiFi i odłącz kabel sieciowy. Jeśli to maszyna wirtualna, wyłącz adapter sieciowy w ustawieniach hypervisora. Klucze prywatne nigdy nie powinny być generowane na maszynie podłączonej do sieci.

Skopiuj katalog `signer-oss/` na maszynę przez USB — razem z `node_modules/` żeby nie potrzebować dostępu do sieci npm.

Otwórz terminal i przejdź do katalogu `signer-oss/`:

```bash
cd signer-oss
```

Wszystkie poniższe skrypty uruchamiaj z tego katalogu.

---

## Krok 2 — Wygeneruj oba klucze

Uruchom skrypt `setup/airgapped/01-generate-keys.mjs`:

```bash
NETWORK=mainnet node setup/airgapped/01-generate-keys.mjs
```

Użyj `NETWORK=testnet` dla środowiska testowego lub `NETWORK=regtest` dla lokalnego devu.

Skrypt wypisze na stdout sześć wartości. Przepisz je lub zapisz do pliku tymczasowego **na tej samej maszynie** — nie wysyłaj przez sieć, nie kopiuj przez schowek na podłączonej maszynie.

| Wartość | Opis | Gdzie trafi |
|---------|------|-------------|
| `xpub` | Klucz publiczny account node | Silnik — `tenant_configs.btc_xpub` |
| `xprv` | Klucz prywatny account node | Keystore signera (Sekret A) |
| `HD fingerprint` | 4-bajtowy identyfikator klucza HD | Część wartości `SIGNER_FINGERPRINT_HD` |
| `WIF` | Klucz prywatny hot wallet | Keystore signera (Sekret B) |
| `Hot wallet address` | Adres Bitcoin hot wallet | Silnik — rejestracja jako `tenant_hot` |
| `SIGNER_FINGERPRINT` | Identyfikator klucza WIF w keystorze | Plik `.env` signera |
| `SIGNER_FINGERPRINT_HD` | Identyfikator klucza HD w keystorze | Plik `.env` signera |

---

## Krok 3 — Zweryfikuj parę xpub/xprv

Przed tworzeniem keystora upewnij się że `xpub` i `xprv` z Kroku 2 są faktycznie parą — ten sam node BIP32, różne klucze.

```bash
XPUB="xpub6D..." XPRV="xprv9..." NETWORK=mainnet node setup/airgapped/02-verify-keypair.mjs
```

Skrypt:
- Porównuje klucz publiczny wyprowadzony z `xprv` z `xpub` — muszą być identyczne
- Wypisuje fingerprint i depth node — depth powinien wynosić 3 (poziom account w `m/44'/x'/0'`)
- Kończy z kodem wyjścia `1` jeśli para jest niezgodna — **w takim przypadku nie kontynuuj**

---

## Krok 4 — Utwórz zaszyfrowany keystore

Szyfrowanie używa AES-256-GCM z kluczem derywowanym przez PBKDF2 (100 000 iteracji SHA-256). Każdy klucz w keystorze jest szyfrowany osobno z losowym `salt` i `iv`.

Podaj hasło i wartości z outputu Kroku 2 jako zmienne środowiskowe:

```bash
KEYSTORE_PASSWORD='twoje-silne-haslo-min-24-znaki' \
XPRV='xprv9...' \
HD_FINGERPRINT='btc_hd:mainnet:aabbccdd' \
WIF='K...' \
HOT_FINGERPRINT='btc:mainnet:11223344' \
NETWORK=mainnet \
OUTPUT_PATH=./keystore.json \
node setup/airgapped/03-create-keystore.mjs
```

Wartości `HD_FINGERPRINT` i `HOT_FINGERPRINT` to dokładnie `SIGNER_FINGERPRINT_HD` i `SIGNER_FINGERPRINT` z outputu Kroku 2.

Hasło podaj przez zmienną środowiskową, **nie przez argument wywołania** — argumenty lądują w historii powłoki.

Skrypt:
- Tworzy plik `keystore.json` z uprawnieniami `600` (tylko właściciel może czytać)
- Wypisuje finalne wartości `SIGNER_FINGERPRINT` i `SIGNER_FINGERPRINT_HD` do wklejenia do `.env`

**Zapisz hasło w managerze sekretów teraz.** Bez hasła keystore jest bezużyteczny i nie da się go odtworzyć.

Skasuj tymczasowy plik z wartościami kluczy (jeśli go stworzyłeś) i wyczyść historię terminala.

---

## Krok 5 — Przenieś keystore na serwer signera

Skopiuj `keystore.json` na serwer signera przez USB lub bezpieczny kanał (SCP przez wewnętrzną sieć, secret mount w Kubernetes, itp.).

Umieść plik w `signer-oss/data/keystore.json` lub w ścieżce którą ustawisz w `BTC_KEYSTORE_PATH`.

Ustaw uprawnienia:

```bash
chmod 600 ./data/keystore.json
```

Plik `keystore.json` jest zaszyfrowany i bezpieczny do transferu — bez hasła jest bezużyteczny. Hasło i plik keystore przechowuj w **oddzielnych miejscach**.

---

## Krok 6 — Zweryfikuj keystore na serwerze

Na serwerze signera uruchom skrypt weryfikacyjny:

```bash
BTC_KEYSTORE_PATH=./data/keystore.json \
KEYSTORE_PASSWORD='twoje-haslo' \
EXPECTED_FINGERPRINT='btc:mainnet:11223344' \
EXPECTED_FINGERPRINT_HD='btc_hd:mainnet:aabbccdd' \
node setup/online/04-verify-keystore.mjs
```

Skrypt deszyfruje keystore, wypisuje załadowane fingerprints i sprawdza czy zgadzają się z podanymi wartościami oczekiwanymi. Nie wypisuje kluczy prywatnych.

Oczekiwany output:

```
Decrypting btc:mainnet:11223344 (btc)...     OK
Decrypting btc_hd:mainnet:aabbccdd (btc_hd)... OK

SIGNER_FINGERPRINT=btc:mainnet:11223344    → FOUND ✓
SIGNER_FINGERPRINT_HD=btc_hd:mainnet:aabbccdd → FOUND ✓

Keystore is valid.
```

---

## Krok 7 — Skonfiguruj silnik (Engine)

### Ustaw xpub tenanta

Wartość `xpub` z Kroku 2 trafia do silnika przez admin API:

```http
PATCH /admin/v1/tenants/{tenantId}/config
X-Admin-Key: {ADMIN_KEY}
Content-Type: application/json

{
  "btcXpub": "xpub6D..."
}
```

### Utwórz hot wallet i zarejestruj adres

Najpierw utwórz portfel z rolą `tenant_hot`:

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

Następnie zarejestruj adres z Kroku 2 w tym portfelu:

```http
POST /v1/wallets/{walletId}/addresses
Authorization: Bearer {TENANT_API_KEY}
Content-Type: application/json

{
  "address": "bc1q..."
}
```

---

## Krok 8 — Skonfiguruj `.env` signera

Utwórz lub uzupełnij plik `.env` w katalogu `signer-oss/`. Wartości `SIGNER_FINGERPRINT`, `SIGNER_FINGERPRINT_HD` i `BTC_NETWORK` bierzesz z outputu Kroku 4. Hasło pobieraj z managera sekretów przy starcie kontenera/procesu — nie trzymaj go w `.env` w plaintext na dysku produkcyjnym.

```env
# ── Tożsamość ──────────────────────────────────────────────────
SIGNER_MODE=community
SIGNER_ID=signer_prod_1
SIGNER_NAME=Prod Signer 1
TENANT_ID=<tenant_id>

# ── Połączenie z silnikiem ─────────────────────────────────────
CHAIN_API_BASE_URL=https://engine.twoja-domena.com
SIGNER_API_KEY=<api-key-tenanta>

# ── BTC ────────────────────────────────────────────────────────
BTC_NETWORK=mainnet
SUPPORTED_CHAINS=bitcoin
SUPPORTED_ASSETS=bitcoin:BTC
SUPPORTED_FORMATS=btc_psbt

# ── Keystore ───────────────────────────────────────────────────
BTC_SIGNING_MODE=keystore_file
BTC_KEYSTORE_PATH=./data/keystore.json
BTC_KEYSTORE_PASSWORD=<haslo-pobrane-z-managera-sekretow>

# ── Fingerprints — wartości z outputu Kroku 4 ─────────────────
SIGNER_FINGERPRINT=btc:mainnet:11223344
SIGNER_FINGERPRINT_HD=btc_hd:mainnet:aabbccdd

# ── Enrollment ─────────────────────────────────────────────────
SIGNER_AUTO_ENROLL=true
SIGNER_PUBLIC_KEY=ed25519:placeholder

# ── Policy ─────────────────────────────────────────────────────
MAX_AUTO_SIGN_AMOUNT_SATS=5000000
MAX_FEE_RATE_SAT_VB=50
MAX_OUTPUTS_PER_BATCH=200
ALLOWED_DESTINATIONS=

# ── Polling ────────────────────────────────────────────────────
POLL_INTERVAL_MS=5000
TASK_BATCH_SIZE=5

# ── Audit ──────────────────────────────────────────────────────
AUDIT_LOG_FILE=./data/audit.log
AUDIT_STDOUT=true

# ── Status port ────────────────────────────────────────────────
SIGNER_PORT=3101
SIGNER_BIND_HOST=127.0.0.1
```

---

## Krok 9 — Uruchom signer

```bash
cd signer-oss
npm run start
```

Prawidłowy start wygląda tak:

```
[keystore] Key loaded from file: btc:mainnet:11223344 (btc)
[keystore] Key loaded from file: btc_hd:mainnet:aabbccdd (btc_hd)
[signer] Sending heartbeat...
[signer] Status: active
```

Sprawdź enrollment w silniku:

```http
GET /v1/external-signers
Authorization: Bearer {TENANT_API_KEY}
```

Signer powinien mieć `"status": "active"` i `"lastHealthStatus": "healthy"`.

---

## Mapa zależności konfiguracyjnych

```
setup/airgapped/01-generate-keys.mjs
│
├── Sekret A (HD account key)
│   ├── xpub ──────────────────────────► tenant_configs.btc_xpub (silnik, admin API)
│   ├── xprv ──────────────────────────► keystore.json, entry btc_hd (przez 03-create-keystore)
│   └── SIGNER_FINGERPRINT_HD ─────────► .env signera + HD_FINGERPRINT do 03-create-keystore
│
└── Sekret B (hot wallet key)
    ├── WIF ───────────────────────────► keystore.json, entry btc (przez 03-create-keystore)
    ├── hotAddress ────────────────────► wallets/{id}/addresses (silnik, tenant API)
    └── SIGNER_FINGERPRINT ────────────► .env signera + HOT_FINGERPRINT do 03-create-keystore
```

Weryfikacja spójności pary xpub/xprv jest automatyczna przez Bitcoin Core: jeśli `xpub` w silniku i `xprv` w keystorze nie są parą, signer wyprodukuje podpis który nie pasuje do skryptów UTXO, i `testmempoolaccept` odrzuci transakcję. Nie dojdzie do broadcastu ani utraty środków.

---

## Co się stanie gdy klucze się nie zgadzają

| Błąd konfiguracji | Objaw | Etap |
|---|---|---|
| `xpub` i `xprv` nie są parą | Sweep fail: `testmempoolaccept` odrzuca transakcję | Po podpisaniu, przed broadcastem |
| Zły WIF dla hot wallet | Withdrawal batch fail: `testmempoolaccept` odrzuca | Po podpisaniu, przed broadcastem |
| Zły `SIGNER_FINGERPRINT` w `.env` | Crash przy starcie: `No WIF key for fingerprint: ...` | Ładowanie keystora |
| Zły `SIGNER_FINGERPRINT_HD` w `.env` | Crash przy próbie podpisania sweepa: `No HD account xprv for fingerprint: ...` | Podczas podpisywania taska |
| Zły adres hot wallet w silniku | Brak UTXO do coin selection — batche puste, withdrawal queue rośnie | Batcher nie tworzy batchy |

W żadnym przypadku nie ma ryzyka utraty środków — transakcja nie zostanie wybroadcastowana bez pozytywnego `testmempoolaccept`.
