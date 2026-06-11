# chain-api OSS Signer - wytyczne

## Architektura provider-neutral

- OSS signer implementuje ten sam external signer protocol co Enterprise signer. Nie wolno wprowadzac zmian protokolu, ktore wymagaja osobnej sciezki w engine dla OSS albo Enterprise.
- Engine zna tylko signer enrollment, heartbeat, signing tasks, signer responses, fingerprinty i response signing. Engine nie zna providerow kluczy ani sekretow.
- Provider signing/key/secret/policy jest adapterem za interfejsem signera. Dla OSS domyslne adaptery moga byc lokalne/dev, ale musza zachowac kontrakty wspolne z Enterprise.
- Wspolne DTO, zod schemas, payload hashing, polling client i walidacje ida do `../packages/external-signer-protocol` albo `../packages/external-signer-core`.
- Nie dodawaj do OSS logiki biznesowej tenanta, routingu chain nodes ani bezposrednich zaleznosci od bazy engine'u.

## Docker i release

- Publiczny obraz Docker Hub: `chain-api-signer-oss`.
- Workflow buduje obraz z kontekstu workspace zawierajacego `signer-oss/` i sibling `packages/`, bo Dockerfile uzywa lokalnych pakietow external signer.
