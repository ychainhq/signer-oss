/**
 * BtcPsbtAdapter tests (OSS).
 *
 * Uses a real bitcoinjs-lib PSBT fixture built from a known regtest WIF.
 * config is mocked to avoid dotenv/process.exit and to control policy limits.
 */

import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';
import { sha256Hex } from '@chain-api/external-signer-core';
import type { SigningTask } from '@chain-api/external-signer-protocol';

const TEST_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA'; // regtest
const TEST_FINGERPRINT = 'btc:regtest:test0001';

jest.mock('../src/config', () => ({
  config: {
    BTC_NETWORK: 'regtest',
    BTC_SIGNING_MODE: 'dev_env_key',
    BTC_DEV_PRIVATE_KEY_WIF: TEST_WIF,
    SIGNER_FINGERPRINT: TEST_FINGERPRINT,
    MAX_AUTO_SIGN_AMOUNT_SATS: 1_000_000n,
    MAX_FEE_RATE_SAT_VB: 50,
    MAX_OUTPUTS_PER_BATCH: 200,
    ALLOWED_DESTINATIONS: '',
    EVM_SIGNER_FINGERPRINT: undefined,
    EVM_DEV_PRIVATE_KEY_HEX: undefined,
  },
  getAllowedDestinations: () => [],
  getEvmChainIds: () => [],
}));

import { BtcPsbtAdapter } from '../src/adapters/btc-psbt-adapter';
import { LocalKeystore } from '../src/keystore/local-keystore';

const ECPair = ECPairFactory(tinysecp);
const NETWORK = bitcoin.networks.regtest;
const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST   = new Date(Date.now() - 60_000).toISOString();

/** Builds a minimal P2WPKH PSBT signable by TEST_WIF on regtest. */
function buildTestPsbt(): { psbtBase64: string; psbtHash: string } {
  const keyPair = ECPair.fromWIF(TEST_WIF, NETWORK);
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(keyPair.publicKey),
    network: NETWORK,
  });

  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.addInput({
    hash: 'a'.repeat(64),  // 32-byte dummy txid
    index: 0,
    witnessUtxo: {
      script: p2wpkh.output!,
      value: 100_000,
    },
  });
  psbt.addOutput({ address: p2wpkh.address!, value: 90_000 });

  const psbtBase64 = psbt.toBase64();
  return { psbtBase64, psbtHash: sha256Hex(psbtBase64) };
}

function makeTask(overrides: Partial<SigningTask> = {}): SigningTask {
  const { psbtBase64, psbtHash } = buildTestPsbt();
  return {
    id: 'task-btc-001',
    tenantId: 'tenant-1',
    signerId: 'signer-1',
    chain: 'bitcoin',
    assetId: 'bitcoin:BTC',
    payloadFormat: 'btc_psbt',
    unsignedPayload: psbtBase64,
    unsignedPayloadHash: psbtHash,
    amountRaw: '90000',
    feeRateSatVb: 10,
    outputsCount: 1,
    expiresAt: FUTURE,
    status: 'claimed',
    signerFingerprint: TEST_FINGERPRINT,
    claimedAt: new Date().toISOString(),
    signedAt: null,
    ...overrides,
  } as SigningTask;
}

describe('BtcPsbtAdapter (OSS)', () => {
  let keystore: LocalKeystore;
  let adapter: BtcPsbtAdapter;

  beforeAll(async () => {
    keystore = new LocalKeystore();
    await keystore.load();
    adapter = new BtcPsbtAdapter(keystore);
  });

  describe('canHandle()', () => {
    it('returns true for btc_psbt on chain bitcoin', () => {
      expect(adapter.canHandle(makeTask())).toBe(true);
    });

    it('returns false for evm_raw_tx', () => {
      expect(adapter.canHandle(makeTask({ payloadFormat: 'evm_raw_tx', chain: 'ethereum:1' }))).toBe(false);
    });

    it('returns false for btc_psbt on a non-bitcoin chain', () => {
      expect(adapter.canHandle(makeTask({ chain: 'bitcoin-testnet' }))).toBe(false);
    });
  });

  describe('sign() — happy path', () => {
    it('signs a valid PSBT and returns signedPayload', async () => {
      const result = await adapter.sign(makeTask());
      expect(result.signedPayload).toBeTruthy();
      expect(typeof result.signedPayload).toBe('string');
    });

    it('signedPayloadHash is sha256 of signedPayload', async () => {
      const result = await adapter.sign(makeTask());
      expect(result.signedPayloadHash).toBe(sha256Hex(result.signedPayload));
    });

    it('signerFingerprint matches TEST_FINGERPRINT', async () => {
      const result = await adapter.sign(makeTask());
      expect(result.signerFingerprint).toBe(TEST_FINGERPRINT);
    });

    it('signedAt is an ISO timestamp', async () => {
      const result = await adapter.sign(makeTask());
      expect(new Date(result.signedAt).getTime()).toBeGreaterThan(0);
    });

    it('output PSBT is different from input (has signatures)', async () => {
      const task = makeTask();
      const result = await adapter.sign(task);
      expect(result.signedPayload).not.toBe(task.unsignedPayload);
    });
  });

  describe('sign() — error cases', () => {
    it('throws when unsignedPayloadHash does not match payload', async () => {
      const task = makeTask({ unsignedPayloadHash: 'deadbeef00000000' });
      await expect(adapter.sign(task)).rejects.toThrow(/hash mismatch/i);
    });

    it('throws with policy code when amount exceeds limit', async () => {
      const task = makeTask({ amountRaw: '9999999' });
      await expect(adapter.sign(task)).rejects.toThrow(/auto.sign limit|amount/i);
    });

    it('throws with policy code when fee rate exceeds limit', async () => {
      const task = makeTask({ feeRateSatVb: 999 });
      await expect(adapter.sign(task)).rejects.toThrow(/fee rate/i);
    });

    it('throws when task is expired', async () => {
      const task = makeTask({ expiresAt: PAST });
      await expect(adapter.sign(task)).rejects.toThrow(/expired/i);
    });

    it('throws when PSBT payload is invalid base64/PSBT', async () => {
      const badPayload = Buffer.from('not-a-psbt').toString('base64');
      const task = makeTask({
        unsignedPayload: badPayload,
        unsignedPayloadHash: sha256Hex(badPayload),
      });
      await expect(adapter.sign(task)).rejects.toThrow(/parse PSBT|Failed/i);
    });
  });
});
