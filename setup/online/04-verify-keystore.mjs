#!/usr/bin/env node
/**
 * 04-verify-keystore.mjs — Verify that the keystore file is valid and loadable.
 *
 * Safe to run on the signer server or any machine with access to the keystore file.
 * This script does NOT print private key material — it only confirms decryption
 * succeeds and prints fingerprints.
 *
 * Usage (run from signer-oss/ directory):
 *   BTC_KEYSTORE_PATH=./data/keystore.json \
 *   KEYSTORE_PASSWORD='...' \
 *   EXPECTED_FINGERPRINT='btc:mainnet:11223344' \
 *   EXPECTED_FINGERPRINT_HD='btc_hd:mainnet:aabbccdd' \
 *   node setup/online/04-verify-keystore.mjs
 *
 * EXPECTED_FINGERPRINT and EXPECTED_FINGERPRINT_HD are optional.
 * When provided, the script checks that matching entries exist in the keystore
 * and cross-validates them against the SIGNER_FINGERPRINT / SIGNER_FINGERPRINT_HD
 * values you intend to use in .env.
 *
 * Exit codes:
 *   0 — keystore valid, all checks passed
 *   1 — file missing, wrong password, corrupted entry, or fingerprint mismatch
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// ─── Inputs ───────────────────────────────────────────────────────────────────
const KEYSTORE_PATH   = process.env.BTC_KEYSTORE_PATH ?? './data/keystore.json';
const PASSWORD        = process.env.KEYSTORE_PASSWORD;
const EXPECTED_FP     = process.env.EXPECTED_FINGERPRINT;
const EXPECTED_FP_HD  = process.env.EXPECTED_FINGERPRINT_HD;

if (!PASSWORD) {
  console.error('ERROR: KEYSTORE_PASSWORD environment variable is required.');
  console.error();
  console.error('Usage:');
  console.error('  BTC_KEYSTORE_PATH=./data/keystore.json \\');
  console.error('  KEYSTORE_PASSWORD=\'...\' \\');
  console.error('  EXPECTED_FINGERPRINT=\'btc:mainnet:...\' \\');
  console.error('  EXPECTED_FINGERPRINT_HD=\'btc_hd:mainnet:...\' \\');
  console.error('  node setup/online/04-verify-keystore.mjs');
  process.exit(1);
}

// ─── Read file ────────────────────────────────────────────────────────────────
const absPath = path.resolve(KEYSTORE_PATH);

let raw;
try {
  raw = fs.readFileSync(absPath, 'utf8');
} catch (e) {
  console.error(`ERROR: Cannot read keystore file at ${absPath}`);
  console.error(`  ${e.message}`);
  console.error();
  console.error('Make sure BTC_KEYSTORE_PATH points to the keystore.json produced by 03-create-keystore.mjs.');
  process.exit(1);
}

// ─── Parse JSON ───────────────────────────────────────────────────────────────
let keystoreFile;
try {
  keystoreFile = JSON.parse(raw);
} catch {
  console.error('ERROR: Keystore file is not valid JSON.');
  process.exit(1);
}

if (!keystoreFile || typeof keystoreFile !== 'object') {
  console.error('ERROR: Keystore file has unexpected format.');
  process.exit(1);
}

if (keystoreFile.version !== 1) {
  console.error(`ERROR: Unsupported keystore version: ${keystoreFile.version} (expected 1).`);
  process.exit(1);
}

if (!Array.isArray(keystoreFile.keys) || keystoreFile.keys.length === 0) {
  console.error('ERROR: Keystore file contains no key entries.');
  process.exit(1);
}

// ─── Decryption helper ────────────────────────────────────────────────────────
function pbkdf2Key(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
}

// ─── Decrypt each entry ───────────────────────────────────────────────────────
const thin = '─'.repeat(62);

console.log();
console.log(`  Keystore : ${absPath}`);
console.log(`  Entries  : ${keystoreFile.keys.length}`);
console.log();

let allDecryptOk = true;
const loaded = [];

for (const entry of keystoreFile.keys) {
  const label = `${entry.fingerprint} (${entry.chainType})`;
  process.stdout.write(`  Decrypting ${label.padEnd(46, ' ')} ... `);

  // Validate entry fields
  if (!entry.salt || !entry.iv || !entry.tag || !entry.ciphertext || !entry.fingerprint || !entry.chainType) {
    console.log('FAILED — entry missing required fields');
    allDecryptOk = false;
    continue;
  }

  try {
    const salt       = Buffer.from(entry.salt, 'hex');
    const iv         = Buffer.from(entry.iv, 'hex');
    const tag        = Buffer.from(entry.tag, 'hex');
    const ciphertext = Buffer.from(entry.ciphertext, 'hex');
    const aesKey     = pbkdf2Key(PASSWORD, salt);
    const decipher   = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
    decipher.setAuthTag(tag);

    // Decrypt and discard — we only verify the decryption succeeds, never print plaintext
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Basic sanity: plaintext should be non-empty
    if (!plaintext.length) {
      console.log('FAILED — decrypted to empty content');
      allDecryptOk = false;
      continue;
    }

    console.log('OK');
    loaded.push({ fingerprint: entry.fingerprint, chainType: entry.chainType });
  } catch {
    console.log('FAILED — wrong password or corrupted entry');
    allDecryptOk = false;
  }
}

if (!allDecryptOk) {
  console.error();
  console.error('ERROR: One or more entries failed to decrypt.');
  console.error('Check KEYSTORE_PASSWORD or re-create the keystore with 03-create-keystore.mjs.');
  process.exit(1);
}

// ─── Fingerprint cross-check ──────────────────────────────────────────────────
const loadedFps = new Set(loaded.map(e => e.fingerprint));
let allFpOk = true;

if (EXPECTED_FP || EXPECTED_FP_HD) {
  console.log();
  console.log('  Checking expected fingerprints (from .env):');
  console.log();

  if (EXPECTED_FP) {
    const found = loadedFps.has(EXPECTED_FP);
    const status = found ? 'FOUND ✓' : 'NOT FOUND ✗';
    console.log(`  SIGNER_FINGERPRINT=${EXPECTED_FP}`);
    console.log(`    → ${status}`);
    if (!found) allFpOk = false;
  }

  if (EXPECTED_FP_HD) {
    const found = loadedFps.has(EXPECTED_FP_HD);
    const status = found ? 'FOUND ✓' : 'NOT FOUND ✗';
    console.log(`  SIGNER_FINGERPRINT_HD=${EXPECTED_FP_HD}`);
    console.log(`    → ${status}`);
    if (!found) allFpOk = false;
  }
}

// ─── Result ───────────────────────────────────────────────────────────────────
console.log();
console.log(thin);

if (!allFpOk) {
  console.error('  RESULT: FAILED — fingerprint mismatch');
  console.error(thin);
  console.error();
  console.error('  The expected fingerprints are not present in the keystore.');
  console.error('  Check that SIGNER_FINGERPRINT and SIGNER_FINGERPRINT_HD in your .env');
  console.error('  match the fingerprints used when creating the keystore.');
  process.exit(1);
}

console.log('  RESULT: OK — keystore is valid ✓');
console.log(thin);
console.log();
console.log('  Loaded keys:');
loaded.forEach(e => {
  console.log(`    ${e.fingerprint}  (${e.chainType})`);
});
console.log();
console.log('  The signer can now be started with BTC_SIGNING_MODE=keystore_file.');
console.log();
