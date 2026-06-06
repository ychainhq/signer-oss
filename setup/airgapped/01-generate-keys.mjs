#!/usr/bin/env node
/**
 * 01-generate-keys.mjs — Generate BTC signing keys for chain-api OSS Signer.
 *
 * !! RUN ON AIR-GAPPED MACHINE ONLY. Never run connected to the internet. !!
 *
 * Generates two independent secrets:
 *   Secret A — HD account key (xpub/xprv) for sweep signing
 *   Secret B — Hot wallet key (WIF/address) for withdrawal batch signing
 *
 * Usage (run from signer-oss/ directory):
 *   NETWORK=mainnet node setup/airgapped/01-generate-keys.mjs
 *   NETWORK=testnet node setup/airgapped/01-generate-keys.mjs
 *   NETWORK=regtest node setup/airgapped/01-generate-keys.mjs
 *
 * Default network: mainnet
 */

import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import ECPairFactory from 'ecpair';
import crypto from 'crypto';

// ─── ECC init ────────────────────────────────────────────────────────────────
try { bitcoin.initEccLib(ecc); } catch { /* already initialized */ }
const bip32 = BIP32Factory(ecc);
const ECPair = ECPairFactory(ecc);

// ─── Network ─────────────────────────────────────────────────────────────────
const NETWORK_NAME = process.env.NETWORK ?? 'mainnet';
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
// BIP-44 coin type: 0 for mainnet, 1 for testnet/regtest
const coinType = NETWORK_NAME === 'mainnet' ? 0 : 1;

// ─── Helper: hash160 (SHA256 then RIPEMD160) ─────────────────────────────────
function hash160(buf) {
  const sha = crypto.createHash('sha256').update(buf).digest();
  return crypto.createHash('ripemd160').update(sha).digest();
}

// ─── Secret A: HD account key ─────────────────────────────────────────────────
// Derives account node at m/44'/{coinType}'/0'.
// xpub goes to the engine. xprv stays in the signer keystore.
const hdSeed = crypto.randomBytes(64);
const hdRoot = bip32.fromSeed(hdSeed, network);
const accountNode = hdRoot.derivePath(`m/44'/${coinType}'/0'`);

const XPUB              = accountNode.neutered().toBase58();
const XPRV              = accountNode.toBase58();
const hdFingerprintHex  = Buffer.from(accountNode.fingerprint).toString('hex');
const SIGNER_FP_HD      = `btc_hd:${NETWORK_NAME}:${hdFingerprintHex}`;

// ─── Secret B: Hot wallet key ─────────────────────────────────────────────────
// Generated independently — NOT derived from the HD seed.
// A separate secret limits blast radius: compromising one key does not expose the other.
const hotKeyPair = ECPair.makeRandom({ network });
const HOT_WIF    = hotKeyPair.toWIF();

const { address: HOT_ADDRESS } = bitcoin.payments.p2wpkh({
  pubkey: Buffer.from(hotKeyPair.publicKey),
  network,
});

// Fingerprint: first 4 bytes of hash160(pubkey) — same convention as BIP32 fingerprints
const hotFingerprintHex = hash160(Buffer.from(hotKeyPair.publicKey)).slice(0, 4).toString('hex');
const SIGNER_FP         = `btc:${NETWORK_NAME}:${hotFingerprintHex}`;

// ─── Output ───────────────────────────────────────────────────────────────────
const line = '═'.repeat(64);
const thin = '─'.repeat(64);

console.log();
console.log(line);
console.log('  BTC SIGNER KEY GENERATION');
console.log(`  Network : ${NETWORK_NAME.toUpperCase()}`);
console.log(`  Time    : ${new Date().toISOString()}`);
console.log(line);

console.log(`
┌─ SECRET A ─ HD ACCOUNT KEY (sweep signing) ${'─'.repeat(19)}┐

  Goes to ENGINE (public — safe to store):
  xpub  =  ${XPUB}

  Goes to SIGNER KEYSTORE (private — never share):
  xprv  =  ${XPRV}

  BIP32 fingerprint (4 bytes):
  HD fingerprint  =  ${hdFingerprintHex}

  Value for signer .env and for 03-create-keystore.mjs HD_FINGERPRINT:
  SIGNER_FINGERPRINT_HD  =  ${SIGNER_FP_HD}

└${'─'.repeat(64)}┘`);

console.log(`
┌─ SECRET B ─ HOT WALLET KEY (withdrawal batch signing) ${'─'.repeat(8)}┐

  Goes to SIGNER KEYSTORE (private — never share):
  WIF  =  ${HOT_WIF}

  Goes to ENGINE (public — safe to store):
  Hot wallet address  =  ${HOT_ADDRESS}

  Value for signer .env and for 03-create-keystore.mjs HOT_FINGERPRINT:
  SIGNER_FINGERPRINT  =  ${SIGNER_FP}

└${'─'.repeat(64)}┘`);

console.log(`
${thin}
  NEXT STEPS
${thin}
  1. Record ALL values above in a secure location (secrets manager / vault).
  2. Verify the xpub/xprv pair:
       XPUB="${XPUB.slice(0, 20)}..." \\
       XPRV="${XPRV.slice(0, 20)}..." \\
       NETWORK=${NETWORK_NAME} \\
       node setup/airgapped/02-verify-keypair.mjs
  3. Create the encrypted keystore:
       node setup/airgapped/03-create-keystore.mjs  (see its usage comment)
  4. Transfer keystore.json to the signer server.
  5. Clear this terminal session and delete any temporary files.
${thin}
`);
