#!/usr/bin/env node
/**
 * 03-create-keystore.mjs — Encrypt BTC signing keys into a keystore file.
 *
 * !! RUN ON AIR-GAPPED MACHINE ONLY (handles private key material). !!
 *
 * Encryption: AES-256-GCM, key derived via PBKDF2 (100 000 SHA-256 iterations).
 * Each key entry is encrypted independently with its own random salt and IV.
 * Output format is compatible with LocalKeystore in src/keystore/local-keystore.ts.
 *
 * Usage (run from signer-oss/ directory):
 *   KEYSTORE_PASSWORD='...' \
 *   XPRV='xprv9...' \
 *   HD_FINGERPRINT='btc_hd:mainnet:aabbccdd' \
 *   WIF='K...' \
 *   HOT_FINGERPRINT='btc:mainnet:11223344' \
 *   NETWORK=mainnet \
 *   OUTPUT_PATH=./keystore.json \
 *   node setup/airgapped/03-create-keystore.mjs
 *
 * HD_FINGERPRINT  = SIGNER_FINGERPRINT_HD from 01-generate-keys.mjs output
 * HOT_FINGERPRINT = SIGNER_FINGERPRINT    from 01-generate-keys.mjs output
 * OUTPUT_PATH defaults to ./keystore.json
 *
 * Exit codes:
 *   0 — keystore created successfully
 *   1 — missing input, validation failure, or write error
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─── Inputs ───────────────────────────────────────────────────────────────────
const PASSWORD        = process.env.KEYSTORE_PASSWORD;
const XPRV            = process.env.XPRV;
const HD_FINGERPRINT  = process.env.HD_FINGERPRINT;
const WIF             = process.env.WIF;
const HOT_FINGERPRINT = process.env.HOT_FINGERPRINT;
const NETWORK         = process.env.NETWORK ?? 'mainnet';
const OUTPUT_PATH     = process.env.OUTPUT_PATH ?? './keystore.json';

// ─── Validation ───────────────────────────────────────────────────────────────
const missing = [];
if (!PASSWORD)        missing.push('KEYSTORE_PASSWORD');
if (!XPRV)            missing.push('XPRV');
if (!HD_FINGERPRINT)  missing.push('HD_FINGERPRINT');
if (!WIF)             missing.push('WIF');
if (!HOT_FINGERPRINT) missing.push('HOT_FINGERPRINT');

if (missing.length > 0) {
  console.error('ERROR: Missing required environment variables:');
  missing.forEach(v => console.error(`  ${v}`));
  console.error();
  console.error('Usage:');
  console.error('  KEYSTORE_PASSWORD=\'...\' \\');
  console.error('  XPRV=\'xprv9...\' \\');
  console.error('  HD_FINGERPRINT=\'btc_hd:mainnet:aabbccdd\' \\');
  console.error('  WIF=\'K...\' \\');
  console.error('  HOT_FINGERPRINT=\'btc:mainnet:11223344\' \\');
  console.error('  NETWORK=mainnet \\');
  console.error('  node setup/airgapped/03-create-keystore.mjs');
  process.exit(1);
}

if (PASSWORD.length < 24) {
  console.error('ERROR: KEYSTORE_PASSWORD must be at least 24 characters.');
  console.error('Generate a strong password with: openssl rand -base64 32');
  process.exit(1);
}

const validNetworks = ['mainnet', 'testnet', 'regtest'];
if (!validNetworks.includes(NETWORK)) {
  console.error(`ERROR: NETWORK must be one of: ${validNetworks.join(', ')}`);
  process.exit(1);
}

// Basic format checks
if (!HD_FINGERPRINT.startsWith('btc_hd:')) {
  console.error(`ERROR: HD_FINGERPRINT should start with "btc_hd:" (got "${HD_FINGERPRINT}")`);
  console.error('Use the SIGNER_FINGERPRINT_HD value from 01-generate-keys.mjs output.');
  process.exit(1);
}
if (!HOT_FINGERPRINT.startsWith('btc:')) {
  console.error(`ERROR: HOT_FINGERPRINT should start with "btc:" (got "${HOT_FINGERPRINT}")`);
  console.error('Use the SIGNER_FINGERPRINT value from 01-generate-keys.mjs output.');
  process.exit(1);
}

// ─── Encryption helpers ───────────────────────────────────────────────────────
// Identical to LocalKeystore.encryptKey() in src/keystore/local-keystore.ts
// so the output file is directly loadable by the signer without conversion.

function pbkdf2Key(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
}

function encryptEntry(fingerprint, chainType, plaintext, password, network) {
  const salt       = crypto.randomBytes(32);
  const iv         = crypto.randomBytes(12);
  const aesKey     = pbkdf2Key(password, salt);
  const cipher     = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag        = cipher.getAuthTag();
  return {
    fingerprint,
    chainType,
    network,
    salt:       salt.toString('hex'),
    iv:         iv.toString('hex'),
    tag:        tag.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
  };
}

// ─── Build keystore ───────────────────────────────────────────────────────────
const thin = '─'.repeat(60);

console.log();
console.log(`  Building keystore for network: ${NETWORK}`);
console.log();

process.stdout.write(`  Encrypting hot wallet key   (btc)    fingerprint=${HOT_FINGERPRINT} ... `);
const btcEntry = encryptEntry(HOT_FINGERPRINT, 'btc', WIF, PASSWORD, NETWORK);
console.log('done');

process.stdout.write(`  Encrypting HD account key   (btc_hd) fingerprint=${HD_FINGERPRINT} ... `);
const hdEntry = encryptEntry(HD_FINGERPRINT, 'btc_hd', XPRV, PASSWORD, NETWORK);
console.log('done');

const keystoreFile = {
  version: 1,
  keys: [btcEntry, hdEntry],
};

// ─── Write file ───────────────────────────────────────────────────────────────
const outputAbs = path.resolve(OUTPUT_PATH);
const outputDir = path.dirname(outputAbs);

try {
  fs.mkdirSync(outputDir, { recursive: true });
} catch (e) {
  console.error(`ERROR: Cannot create output directory ${outputDir}: ${e.message}`);
  process.exit(1);
}

try {
  fs.writeFileSync(outputAbs, JSON.stringify(keystoreFile, null, 2), { mode: 0o600 });
} catch (e) {
  console.error(`ERROR: Cannot write keystore file to ${outputAbs}: ${e.message}`);
  process.exit(1);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log();
console.log(thin);
console.log('  KEYSTORE CREATED');
console.log(thin);
console.log();
console.log(`  File        : ${outputAbs}`);
console.log(`  Permissions : 600 (owner read/write only)`);
console.log(`  Entries     : 2  (btc + btc_hd)`);
console.log();
console.log('  Add these lines to the signer .env:');
console.log();
console.log(`  BTC_SIGNING_MODE=keystore_file`);
console.log(`  BTC_KEYSTORE_PATH=./data/keystore.json`);
console.log(`  BTC_NETWORK=${NETWORK}`);
console.log(`  SIGNER_FINGERPRINT=${HOT_FINGERPRINT}`);
console.log(`  SIGNER_FINGERPRINT_HD=${HD_FINGERPRINT}`);
console.log();
console.log(thin);
console.log('  NEXT STEPS');
console.log(thin);
console.log();
console.log('  1. Store KEYSTORE_PASSWORD in your secrets manager (if not done yet).');
console.log(`  2. Transfer ${outputAbs} to the signer server.`);
console.log('  3. On the signer server, verify with:');
console.log('       node setup/online/04-verify-keystore.mjs');
console.log('  4. Clear terminal history and delete any plaintext key files.');
console.log();
