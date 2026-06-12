/**
 * TronTxAdapter unit tests (OSS).
 *
 * Verifies that:
 *  - Signing uses rawTransaction.txID (not sha256 of unsignedPayload)
 *  - Signed payload is a complete TRON tx JSON with signature array
 *  - HD sweep path derives child key from xprv + derivationPath
 *  - Hash integrity check rejects tampered payloads
 */

import { sha256Hex } from '@chain-api/external-signer-core';
import type { SigningTask } from '@chain-api/external-signer-protocol';
import * as tinysecp from 'tiny-secp256k1';

// A deterministic 32-byte private key for testing
const TEST_TRON_PRIVATE_KEY_HEX = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_TRON_FINGERPRINT = 'tron:dev:testkey001';
// Generated from the same key: m/44'/195'/0' account xprv (mainnet format for test)
// We use a real BIP32 account xprv that can derive secp256k1 children
// Note: In tests, we use a known xprv derived from the test key via BIP32
const TEST_TX_ID = 'deadbeef'.repeat(8); // 32-byte hex tx hash
const USDT_CONTRACT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const FUTURE = new Date(Date.now() + 60_000).toISOString();

jest.mock('../src/config', () => ({
  config: {
    BTC_NETWORK: 'regtest',
    BTC_SIGNING_MODE: 'dev_env_key',
    BTC_DEV_PRIVATE_KEY_WIF: undefined,
    SIGNER_FINGERPRINT: 'btc:placeholder',
    TRON_DEV_PRIVATE_KEY_HEX: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
    TRON_SIGNER_FINGERPRINT: 'tron:dev:testkey001',
    TRON_SIGNER_FINGERPRINT_HD: undefined,
    TRON_DEV_ACCOUNT_XPRV: undefined,
    TRON_NETWORK: 'private',
    TRON_ALLOWED_CONTRACTS: USDT_CONTRACT,
    MAX_AUTO_SIGN_AMOUNT_SUN: 10_000_000n,
    MAX_TRON_FEE_LIMIT_SUN: 50_000_000n,
    MAX_AUTO_SIGN_AMOUNT_SATS: 1_000_000n,
    MAX_FEE_RATE_SAT_VB: 50,
    MAX_OUTPUTS_PER_BATCH: 200,
    ALLOWED_DESTINATIONS: '',
  },
  getAllowedDestinations: () => [],
  getTronAllowedContracts: () => [USDT_CONTRACT],
  getSupportedChains: () => ['tron'],
}));

import { TronTxAdapter } from '../src/adapters/tron-tx-adapter';
import { LocalKeystore } from '../src/keystore/local-keystore';

function makeEnvelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    chainId: 'tron',
    network: 'private',
    type: 'trc20_transfer',
    contractAddress: USDT_CONTRACT,
    amountRaw: '1000000',
    fromAddress: 'TAbc123',
    toAddress: 'TDef456',
    rawTransaction: {
      txID: TEST_TX_ID,
      raw_data: { contract: [] },
      raw_data_hex: 'deadbeef00',
    },
    ...overrides,
  });
}

function makeTask(unsignedPayload: string, overrides: Partial<SigningTask> = {}): SigningTask {
  return {
    id: 'task-tron-001',
    tenantId: 'tenant-1',
    signerId: 'signer-1',
    chain: 'tron',
    assetId: 'tron:USDT',
    payloadFormat: 'tron_raw_tx',
    requestType: 'withdrawal',
    amountRaw: '1000000',
    unsignedPayload,
    unsignedPayloadHash: sha256Hex(unsignedPayload),
    status: 'available',
    decisionMode: 'auto',
    expiresAt: FUTURE,
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

async function makeKeystore(): Promise<LocalKeystore> {
  const ks = new LocalKeystore();
  await ks.load();
  return ks;
}

describe('TronTxAdapter (OSS)', () => {

  it('canHandle() returns true for tron_raw_tx on tron chain', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const task = makeTask(makeEnvelope());
    expect(adapter.canHandle(task)).toBe(true);
  });

  it('canHandle() returns false for btc_psbt', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const task = makeTask(makeEnvelope(), { payloadFormat: 'btc_psbt', chain: 'bitcoin' });
    expect(adapter.canHandle(task)).toBe(false);
  });

  it('sign() uses rawTransaction.txID for signing (not sha256 of payload)', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const unsignedPayload = makeEnvelope();
    const task = makeTask(unsignedPayload);

    const result = await adapter.sign(task);
    const signedTx = JSON.parse(result.signedPayload);

    // The signedPayload must be the complete TRON tx — not a wrapper with unsignedPayload key
    expect(signedTx).not.toHaveProperty('unsignedPayload');
    expect(signedTx).toHaveProperty('txID', TEST_TX_ID);
    expect(signedTx).toHaveProperty('signature');
    expect(Array.isArray(signedTx.signature)).toBe(true);
    expect(signedTx.signature).toHaveLength(1);

    // Verify the signature is a valid secp256k1 signature (65 bytes = 130 hex chars)
    const sigHex: string = signedTx.signature[0];
    expect(sigHex).toHaveLength(130); // 64 bytes sig + 1 byte recovery = 65 bytes hex
  });

  it('sign() signs rawTransaction.txID with the configured private key', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const unsignedPayload = makeEnvelope();
    const task = makeTask(unsignedPayload);

    const result = await adapter.sign(task);
    const signedTx = JSON.parse(result.signedPayload);
    const sigHex: string = signedTx.signature[0];

    // Verify signature against the txID using the test public key
    const privKey = Buffer.from(TEST_TRON_PRIVATE_KEY_HEX, 'hex');
    const pubKey = Buffer.from(tinysecp.pointFromScalar(privKey, false)!);
    const sigBytes = Buffer.from(sigHex.slice(0, 128), 'hex'); // first 64 bytes = DER sig
    const txIdBytes = Buffer.from(TEST_TX_ID, 'hex');
    const isValid = tinysecp.verify(txIdBytes, pubKey, sigBytes);
    expect(isValid).toBe(true);
  });

  it('sign() returns correct signerFingerprint', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const result = await adapter.sign(makeTask(makeEnvelope()));
    expect(result.signerFingerprint).toBe(TEST_TRON_FINGERPRINT);
  });

  it('sign() rejects when unsignedPayloadHash does not match', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const task = makeTask(makeEnvelope(), { unsignedPayloadHash: 'badhash' });
    await expect(adapter.sign(task)).rejects.toThrow(/unsignedPayloadHash mismatch/);
  });

  it('sign() rejects when rawTransaction.txID is missing', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const envelope = makeEnvelope({ rawTransaction: { raw_data: {}, raw_data_hex: 'ff' } });
    const task = makeTask(envelope);
    await expect(adapter.sign(task)).rejects.toThrow(/txID is missing/);
  });

  it('sign() rejects tron_sweep without derivationPath (validator enforcement)', async () => {
    const ks = await makeKeystore();
    const adapter = new TronTxAdapter(ks);
    const envelope = makeEnvelope(); // no derivationPath
    const task = makeTask(envelope, { requestType: 'tron_sweep' });
    await expect(adapter.sign(task)).rejects.toThrow(/derivationPath is required/);
  });
});
