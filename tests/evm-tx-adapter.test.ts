/**
 * EvmTxAdapter tests (OSS).
 *
 * unsignedPayload must be exactly 32-byte hex (keccak256 of tx) as per adapter contract.
 * config is mocked to control EVM_CHAIN_IDS and EVM_SIGNER_FINGERPRINT.
 */

import { sha256Hex } from '@chain-api/external-signer-core';
import type { SigningTask } from '@chain-api/external-signer-protocol';

const TEST_EVM_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const TEST_EVM_FINGERPRINT = 'evm:dev:test0001';

// A 32-byte hex string that represents a keccak256 hash to sign
const TEST_TX_HASH = 'a'.repeat(64);  // 32 bytes of 0xaa

jest.mock('../src/config', () => ({
  config: {
    BTC_NETWORK: 'regtest',
    BTC_SIGNING_MODE: 'dev_env_key',
    BTC_DEV_PRIVATE_KEY_WIF: undefined,
    SIGNER_FINGERPRINT: 'btc:placeholder',
    EVM_DEV_PRIVATE_KEY_HEX: TEST_EVM_HEX,
    EVM_SIGNER_FINGERPRINT: TEST_EVM_FINGERPRINT,
    EVM_CHAIN_IDS: '1,137',
    MAX_AUTO_SIGN_AMOUNT_SATS: 1_000_000n,
    MAX_FEE_RATE_SAT_VB: 50,
    MAX_OUTPUTS_PER_BATCH: 200,
    ALLOWED_DESTINATIONS: '',
  },
  getAllowedDestinations: () => [],
  getEvmChainIds: () => [1, 137],
}));

import { EvmTxAdapter } from '../src/adapters/evm-tx-adapter';
import { LocalKeystore } from '../src/keystore/local-keystore';

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST   = new Date(Date.now() - 60_000).toISOString();

function makeTask(overrides: Partial<SigningTask> = {}): SigningTask {
  return {
    id: 'task-evm-001',
    tenantId: 'tenant-1',
    signerId: 'signer-1',
    chain: 'ethereum:1',
    assetId: 'ethereum:ETH',
    payloadFormat: 'evm_raw_tx',
    unsignedPayload: TEST_TX_HASH,
    unsignedPayloadHash: sha256Hex(TEST_TX_HASH),
    amountRaw: '100000000000000000',  // 0.1 ETH
    feeRateSatVb: null,
    outputsCount: null,
    expiresAt: FUTURE,
    status: 'claimed',
    signerFingerprint: TEST_EVM_FINGERPRINT,
    claimedAt: new Date().toISOString(),
    signedAt: null,
    ...overrides,
  } as SigningTask;
}

describe('EvmTxAdapter (OSS)', () => {
  let keystore: LocalKeystore;
  let adapter: EvmTxAdapter;

  beforeAll(async () => {
    keystore = new LocalKeystore();
    await keystore.load();
    adapter = new EvmTxAdapter(keystore);
  });

  describe('canHandle()', () => {
    it('returns true for evm_raw_tx on ethereum chain', () => {
      expect(adapter.canHandle(makeTask())).toBe(true);
    });

    it('returns true for polygon chain', () => {
      expect(adapter.canHandle(makeTask({ chain: 'polygon:137' }))).toBe(true);
    });

    it('returns false for btc_psbt', () => {
      expect(adapter.canHandle(makeTask({ payloadFormat: 'btc_psbt', chain: 'bitcoin' }))).toBe(false);
    });

    it('returns false for bitcoin chain', () => {
      expect(adapter.canHandle(makeTask({ chain: 'bitcoin' }))).toBe(false);
    });
  });

  describe('sign() — happy path', () => {
    it('signs a 32-byte hash and returns 0x-prefixed hex', async () => {
      const result = await adapter.sign(makeTask());
      expect(result.signedPayload).toMatch(/^0x[0-9a-f]+$/i);
    });

    it('signature is 65 bytes (r:32 + s:32 + v:1) = 130 hex chars + 0x prefix', async () => {
      const result = await adapter.sign(makeTask());
      // 0x + 64 (r) + 64 (s) + 2 (v) = 132 chars total
      expect(result.signedPayload.length).toBe(132);
    });

    it('signedPayloadHash is sha256 of signedPayload', async () => {
      const result = await adapter.sign(makeTask());
      expect(result.signedPayloadHash).toBe(sha256Hex(result.signedPayload));
    });

    it('signerFingerprint is the EVM fingerprint', async () => {
      const result = await adapter.sign(makeTask());
      expect(result.signerFingerprint).toBe(TEST_EVM_FINGERPRINT);
    });

    it('signing is deterministic for the same key and hash', async () => {
      const task = makeTask();
      const r1 = await adapter.sign(task);
      const r2 = await adapter.sign(task);
      expect(r1.signedPayload).toBe(r2.signedPayload);
    });
  });

  describe('sign() — error cases', () => {
    it('throws when chain ID is not in allowlist', async () => {
      const task = makeTask({ chain: 'arbitrum:42161' });
      await expect(adapter.sign(task)).rejects.toThrow(/42161|chain/i);
    });

    it('throws when task is expired', async () => {
      const task = makeTask({ expiresAt: PAST });
      await expect(adapter.sign(task)).rejects.toThrow(/expired/i);
    });

    it('throws when unsignedPayloadHash does not match', async () => {
      const task = makeTask({ unsignedPayloadHash: 'deadbeef00' });
      await expect(adapter.sign(task)).rejects.toThrow(/hash mismatch/i);
    });

    it('throws when unsignedPayload is not a 32-byte hash', async () => {
      const shortHex = 'aabb';
      const task = makeTask({
        unsignedPayload: shortHex,
        unsignedPayloadHash: sha256Hex(shortHex),
      });
      await expect(adapter.sign(task)).rejects.toThrow(/32-byte/i);
    });
  });
});
