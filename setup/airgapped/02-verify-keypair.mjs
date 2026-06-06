#!/usr/bin/env node
/**
 * 02-verify-keypair.mjs — Verify that xpub and xprv are a matching BIP32 pair.
 *
 * !! RUN ON AIR-GAPPED MACHINE ONLY (reads xprv). !!
 *
 * Checks:
 *   - xprv and xpub decode without error
 *   - The public key derived from xprv matches xpub exactly
 *   - Node depth is 3 (expected for account level m/44'/x'/0')
 *   - Prints the BIP32 fingerprint for cross-checking with SIGNER_FINGERPRINT_HD
 *
 * Usage (run from signer-oss/ directory):
 *   XPUB="xpub6D..." XPRV="xprv9..." NETWORK=mainnet node setup/airgapped/02-verify-keypair.mjs
 *
 * Exit codes:
 *   0 — pair is valid
 *   1 — pair is invalid or inputs are missing/malformed
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';

try { bitcoin.initEccLib(ecc); } catch { /* already initialized */ }
const bip32 = BIP32Factory(ecc);

// ─── Inputs ───────────────────────────────────────────────────────────────────
const XPUB         = process.env.XPUB;
const XPRV         = process.env.XPRV;
const NETWORK_NAME = process.env.NETWORK ?? 'mainnet';

if (!XPUB || !XPRV) {
  console.error('ERROR: XPUB and XPRV environment variables are required.');
  console.error();
  console.error('Usage:');
  console.error('  XPUB="xpub6D..." XPRV="xprv9..." NETWORK=mainnet node setup/airgapped/02-verify-keypair.mjs');
  process.exit(1);
}

const NETWORK_MAP = {
  mainnet: bitcoin.networks.bitcoin,
  testnet: bitcoin.networks.testnet,
  regtest: bitcoin.networks.regtest,
};
const network = NETWORK_MAP[NETWORK_NAME];
if (!network) {
  console.error(`ERROR: Unknown network "${NETWORK_NAME}". Use mainnet, testnet, or regtest.`);
  process.exit(1);
}

// ─── Parse xpub ───────────────────────────────────────────────────────────────
let pubNode;
try {
  pubNode = bip32.fromBase58(XPUB, network);
} catch (e) {
  console.error(`ERROR: Cannot parse XPUB: ${e.message}`);
  console.error('Make sure NETWORK matches the network the key was generated for.');
  process.exit(1);
}

// ─── Parse xprv ───────────────────────────────────────────────────────────────
let privNode;
try {
  privNode = bip32.fromBase58(XPRV, network);
} catch (e) {
  console.error(`ERROR: Cannot parse XPRV: ${e.message}`);
  console.error('Make sure NETWORK matches the network the key was generated for.');
  process.exit(1);
}

if (privNode.isNeutered()) {
  console.error('ERROR: XPRV is neutered — you provided an xpub where an xprv is expected.');
  console.error('Provide the private extended key (starts with "xprv" on mainnet, "tprv" on testnet).');
  process.exit(1);
}

// ─── Compare public keys ─────────────────────────────────────────────────────
const pubFromXpub = Buffer.from(pubNode.publicKey).toString('hex');
const pubFromXprv = Buffer.from(privNode.publicKey).toString('hex');

if (pubFromXpub !== pubFromXprv) {
  console.error();
  console.error('ERROR: xpub and xprv are NOT a matching pair.');
  console.error();
  console.error(`  Public key from xpub : ${pubFromXpub}`);
  console.error(`  Public key from xprv : ${pubFromXprv}`);
  console.error();
  console.error('Consequence: sweeps will fail at testmempoolaccept — signed PSBT will be invalid.');
  console.error('Do NOT proceed. Generate a new key pair with 01-generate-keys.mjs.');
  process.exit(1);
}

// ─── Depth check ─────────────────────────────────────────────────────────────
const depth = pubNode.depth;
const fingerprint = Buffer.from(pubNode.fingerprint).toString('hex');
const thin = '─'.repeat(60);

console.log();
console.log(`${thin}`);
console.log('  KEYPAIR VERIFICATION RESULT');
console.log(`${thin}`);
console.log();
console.log('  Status    : OK — xpub and xprv are a matching pair ✓');
console.log(`  Network   : ${NETWORK_NAME}`);
console.log(`  Depth     : ${depth}  ${depth === 3 ? '✓ (correct for account level m/44\'/x\'/0\')' : '⚠ expected 3'}`);
console.log(`  Fingerprint (4 bytes): ${fingerprint}`);
console.log();
console.log(`  SIGNER_FINGERPRINT_HD should end with: :${fingerprint}`);
console.log(`  E.g.: btc_hd:${NETWORK_NAME}:${fingerprint}`);
console.log();

if (depth !== 3) {
  console.warn(`  WARNING: depth is ${depth}, expected 3 for m/44'/{coinType}'/0'.`);
  console.warn('  Make sure you exported the account-level node, not the root or a child.');
  console.warn('  The signer derives child keys using paths like "0/3" relative to this node.');
  console.warn('  Wrong depth means child derivation will produce wrong keys.');
  console.warn();
}

console.log(`${thin}`);
console.log('  Next: run setup/airgapped/03-create-keystore.mjs');
console.log(`${thin}`);
console.log();
