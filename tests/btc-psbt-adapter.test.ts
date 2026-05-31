/**
 * BtcPsbtAdapter tests (OSS).
 *
 * Uses a real bitcoinjs-lib PSBT fixture built from a known regtest WIF.
 * config is mocked to avoid dotenv/process.exit and to control policy limits.
 */

import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import { sha256Hex } from '@chain-api/external-signer-core';
import type { SigningTask } from '@chain-api/external-signer-protocol';

bitcoin.initEccLib(tinysecp);
const bip32 = BIP32Factory(tinysecp);

const TEST_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA'; // regtest
const TEST_FINGERPRINT = 'btc:regtest:test0001';
const TEST_HD_FINGERPRINT = 'btc_hd:regtest:test0001';
const NETWORK = bitcoin.networks.regtest;

jest.mock('../src/config', () => ({
  config: {
    BTC_NETWORK: 'regtest',
    BTC_SIGNING_MODE: 'dev_env_key',
    BTC_DEV_PRIVATE_KEY_WIF: TEST_WIF,
    BTC_DEV_ACCOUNT_XPRV: undefined, // loaded explicitly in HD tests via keystore mock
    SIGNER_FINGERPRINT: TEST_FINGERPRINT,
    SIGNER_FINGERPRINT_HD: TEST_HD_FINGERPRINT,
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

// ─── HD signing for btc_sweep ─────────────────────────────────────────────────

/**
 * Build a sweep PSBT with bip32Derivation hints for a given account node and child index.
 * This mirrors what engine/psbt-enricher.ts does at runtime.
 */
function buildSweepPsbt(accountNode: ReturnType<typeof bip32.fromSeed>, childIndex: number) {
  const childNode = accountNode.derive(0).derive(childIndex);
  const p2wpkh = bitcoin.payments.p2wpkh({
    pubkey: Buffer.from(childNode.publicKey), network: NETWORK,
  });

  const psbt = new bitcoin.Psbt({ network: NETWORK });
  psbt.addInput({
    hash: 'b'.repeat(64),
    index: childIndex,
    witnessUtxo: { script: p2wpkh.output!, value: 200_000 },
  });
  psbt.addOutput({ address: p2wpkh.address!, value: 190_000 });

  psbt.updateInput(0, {
    bip32Derivation: [{
      pubkey: Buffer.from(childNode.publicKey),
      masterFingerprint: Buffer.from(accountNode.fingerprint),
      path: `m/0/${childIndex}`,
    }],
  });

  const psbtBase64 = psbt.toBase64();
  return { psbtBase64, psbtHash: sha256Hex(psbtBase64) };
}

describe('BtcPsbtAdapter OSS — HD sweep signing', () => {
  // Fresh account node per test suite — deterministic from seed
  const accountNode = bip32.fromSeed(Buffer.alloc(32, 0xAB), NETWORK);
  const accountXprv = accountNode.toBase58();

  // Mock keystore that returns xprv for btc_hd fingerprint
  const mockKeystore = {
    getWif: jest.fn().mockReturnValue(TEST_WIF),
    getXprv: jest.fn().mockReturnValue(accountXprv),
  };

  let hdAdapter: BtcPsbtAdapter;

  beforeAll(() => {
    const { BtcPsbtAdapter: Adapter } = require('../src/adapters/btc-psbt-adapter');
    hdAdapter = new Adapter(mockKeystore);
  });

  function makeSweepTask(overrides: Partial<SigningTask> = {}): SigningTask {
    const { psbtBase64, psbtHash } = buildSweepPsbt(accountNode, 0);
    return {
      id: 'task-sweep-001',
      tenantId: 'tenant-1',
      signerId: 'signer-1',
      requestType: 'btc_sweep',
      chain: 'bitcoin',
      assetId: 'bitcoin:BTC',
      payloadFormat: 'btc_psbt',
      unsignedPayload: psbtBase64,
      unsignedPayloadHash: psbtHash,
      amountRaw: '500000000', // 5 BTC — above auto-sign limit, but manual bypasses it
      feeRateSatVb: 5,
      outputsCount: null,
      expiresAt: FUTURE,
      status: 'claimed',
      decisionMode: 'manual',
      signerFingerprint: TEST_HD_FINGERPRINT,
      claimedAt: new Date().toISOString(),
      signedAt: null,
      ...overrides,
    } as SigningTask;
  }

  it('signs a sweep PSBT using HD key derived from account xprv', async () => {
    const result = await hdAdapter.sign(makeSweepTask());
    expect(result.signedPayload).toBeTruthy();
    expect(result.signedPayloadHash).toBe(sha256Hex(result.signedPayload));
  });

  it('signed payload differs from unsigned (signatures applied)', async () => {
    const task = makeSweepTask();
    const result = await hdAdapter.sign(task);
    expect(result.signedPayload).not.toBe(task.unsignedPayload);
  });

  it('uses SIGNER_FINGERPRINT_HD as signerFingerprint', async () => {
    const result = await hdAdapter.sign(makeSweepTask());
    expect(result.signerFingerprint).toBe(TEST_HD_FINGERPRINT);
  });

  it('signs sweep with amount above auto-sign limit when decisionMode is manual', async () => {
    const result = await hdAdapter.sign(makeSweepTask({ amountRaw: '900000000', decisionMode: 'manual' }));
    expect(result.signedPayload).toBeTruthy();
  });

  it('rejects sweep with amount above limit when decisionMode is auto', async () => {
    await expect(
      hdAdapter.sign(makeSweepTask({ amountRaw: '900000000', decisionMode: 'auto' }))
    ).rejects.toThrow(/auto.sign limit|amount/i);
  });

  it('throws when sweep PSBT input is missing bip32Derivation', async () => {
    // Build a PSBT without bip32Derivation
    const childNode = accountNode.derive(0).derive(0);
    const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(childNode.publicKey), network: NETWORK });
    const psbt = new bitcoin.Psbt({ network: NETWORK });
    psbt.addInput({ hash: 'c'.repeat(64), index: 0, witnessUtxo: { script: p2wpkh.output!, value: 100_000 } });
    psbt.addOutput({ address: p2wpkh.address!, value: 90_000 });
    const psbtBase64 = psbt.toBase64();

    await expect(
      hdAdapter.sign(makeSweepTask({ unsignedPayload: psbtBase64, unsignedPayloadHash: sha256Hex(psbtBase64) }))
    ).rejects.toThrow(/bip32Derivation/i);
  });

  it('withdrawal task (non-sweep) still uses single WIF path', async () => {
    const { psbtBase64, psbtHash } = buildTestPsbt();
    const withdrawalTask = {
      ...makeSweepTask(),
      requestType: 'btc_withdrawal_batch',
      unsignedPayload: psbtBase64,
      unsignedPayloadHash: psbtHash,
      amountRaw: '90000',
      decisionMode: 'auto',
    } as SigningTask;
    const result = await hdAdapter.sign(withdrawalTask);
    expect(result.signedPayload).toBeTruthy();
    expect(mockKeystore.getWif).toHaveBeenCalled();
  });
});
