/**
 * LocalKeystore unit tests.
 *
 * Tests AES-256-GCM encryption round-trip, dev env key loading, WIF decoding,
 * and error handling for missing/corrupted keystores.
 *
 * config is mocked to avoid dotenv/process.exit side effects.
 */

import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// A real secp256k1 WIF key on regtest — known test vector, no real funds.
// Private key bytes: 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20
const TEST_WIF = 'cMahea7zqjxrtgAbB7LSGbcQUr1uX1ojuat9jZodMN87JcbXMTcA'; // regtest WIF
const TEST_FINGERPRINT = 'btc:regtest:test0001';
const TEST_EVM_HEX = '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20';
const TEST_EVM_FINGERPRINT = 'evm:dev:test0001';

function makeMockConfig(overrides: Record<string, unknown> = {}) {
  return {
    BTC_SIGNING_MODE: 'dev_env_key' as const,
    BTC_DEV_PRIVATE_KEY_WIF: TEST_WIF,
    BTC_KEYSTORE_PATH: undefined,
    BTC_KEYSTORE_PASSWORD: undefined,
    BTC_NETWORK: 'regtest' as const,
    EVM_DEV_PRIVATE_KEY_HEX: undefined,
    EVM_SIGNER_FINGERPRINT: TEST_EVM_FINGERPRINT,
    SIGNER_FINGERPRINT: TEST_FINGERPRINT,
    ...overrides,
  };
}

// We need to re-import LocalKeystore after setting up the config mock,
// so we use jest.resetModules() + require() in a beforeEach pattern.

describe('LocalKeystore — dev_env_key mode', () => {
  let LocalKeystore: typeof import('../src/keystore/local-keystore').LocalKeystore;

  beforeEach(() => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig(),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    LocalKeystore = require('../src/keystore/local-keystore').LocalKeystore;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('loads BTC WIF key and exposes fingerprint', async () => {
    const ks = new LocalKeystore();
    await ks.load();
    const fps = await ks.listFingerprints();
    expect(fps).toContain(TEST_FINGERPRINT);
  });

  it('isHealthy() returns true after loading BTC key', async () => {
    const ks = new LocalKeystore();
    await ks.load();
    expect(await ks.isHealthy()).toBe(true);
  });

  it('getKey() returns 32-byte Buffer for BTC fingerprint', async () => {
    const ks = new LocalKeystore();
    await ks.load();
    const key = await ks.getKey(TEST_FINGERPRINT);
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });

  it('getWif() returns the original WIF string', async () => {
    const ks = new LocalKeystore();
    await ks.load();
    expect(ks.getWif(TEST_FINGERPRINT)).toBe(TEST_WIF);
  });

  it('getWif() throws when fingerprint is unknown', async () => {
    const ks = new LocalKeystore();
    await ks.load();
    expect(() => ks.getWif('btc:unknown')).toThrow(/No WIF key/i);
  });

  it('getKey() throws when fingerprint is unknown', async () => {
    const ks = new LocalKeystore();
    await ks.load();
    await expect(ks.getKey('btc:unknown')).rejects.toThrow(/not found/i);
  });

  it('loads EVM hex key when provided', async () => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig({ EVM_DEV_PRIVATE_KEY_HEX: TEST_EVM_HEX }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore: KS } = require('../src/keystore/local-keystore');
    const ks = new KS();
    await ks.load();
    const fps = await ks.listFingerprints();
    expect(fps).toContain(TEST_EVM_FINGERPRINT);
    const key = await ks.getKey(TEST_EVM_FINGERPRINT);
    expect(key.length).toBe(32);
    expect(key.toString('hex')).toBe(TEST_EVM_HEX);
  });

  it('throws when EVM hex has wrong length', async () => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig({
        BTC_DEV_PRIVATE_KEY_WIF: undefined,
        EVM_DEV_PRIVATE_KEY_HEX: 'deadbeef',  // too short
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore: KS } = require('../src/keystore/local-keystore');
    const ks = new KS();
    await expect(ks.load()).rejects.toThrow(/32-byte/i);
  });

  it('throws when no keys provided at all', async () => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig({
        BTC_DEV_PRIVATE_KEY_WIF: undefined,
        EVM_DEV_PRIVATE_KEY_HEX: undefined,
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore: KS } = require('../src/keystore/local-keystore');
    const ks = new KS();
    await expect(ks.load()).rejects.toThrow(/No signing keys/i);
  });
});

describe('LocalKeystore — keystore_file mode (AES-256-GCM round-trip)', () => {
  let tmpDir: string;
  let LocalKeystoreModule: typeof import('../src/keystore/local-keystore');

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ks-test-'));
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig({
        BTC_SIGNING_MODE: 'keystore_file',
        BTC_DEV_PRIVATE_KEY_WIF: undefined,
        BTC_KEYSTORE_PATH: path.join(tmpDir, 'keystore.json'),
        BTC_KEYSTORE_PASSWORD: 'correct-horse-battery',
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    LocalKeystoreModule = require('../src/keystore/local-keystore');
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('round-trip: encryptKey → write file → load → getWif returns original', async () => {
    const { LocalKeystore } = LocalKeystoreModule;
    const password = 'correct-horse-battery';
    const fp = 'btc:regtest:roundtrip01';

    const entry = LocalKeystore.encryptKey(fp, 'btc', TEST_WIF, password, 'regtest');
    const keystoreFile = { version: 1 as const, keys: [entry] };
    const ksPath = path.join(tmpDir, 'keystore.json');
    await fs.writeFile(ksPath, JSON.stringify(keystoreFile), 'utf8');

    const ks = new LocalKeystore();
    await ks.load();

    expect(await ks.listFingerprints()).toContain(fp);
    expect(ks.getWif(fp)).toBe(TEST_WIF);
    const rawKey = await ks.getKey(fp);
    expect(rawKey.length).toBe(32);
  });

  it('throws with wrong password', async () => {
    const { LocalKeystore } = LocalKeystoreModule;
    const entry = LocalKeystore.encryptKey(
      'btc:regtest:wrongpw', 'btc', TEST_WIF, 'correct-password', 'regtest',
    );

    // Write file with a key encrypted with 'correct-password' but load with 'wrong-password'
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig({
        BTC_SIGNING_MODE: 'keystore_file',
        BTC_DEV_PRIVATE_KEY_WIF: undefined,
        BTC_KEYSTORE_PATH: path.join(tmpDir, 'wrong-pw.json'),
        BTC_KEYSTORE_PASSWORD: 'wrong-password',
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore: KS } = require('../src/keystore/local-keystore');

    const ksPath = path.join(tmpDir, 'wrong-pw.json');
    await fs.writeFile(ksPath, JSON.stringify({ version: 1, keys: [entry] }), 'utf8');

    const ks = new KS();
    await expect(ks.load()).rejects.toThrow(/wrong password|corrupted/i);
  });

  it('throws when keystore file is invalid JSON', async () => {
    jest.resetModules();
    const badPath = path.join(tmpDir, 'bad.json');
    await fs.writeFile(badPath, 'not-json', 'utf8');
    jest.doMock('../src/config', () => ({
      config: makeMockConfig({
        BTC_SIGNING_MODE: 'keystore_file',
        BTC_DEV_PRIVATE_KEY_WIF: undefined,
        BTC_KEYSTORE_PATH: badPath,
        BTC_KEYSTORE_PASSWORD: 'any',
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore: KS } = require('../src/keystore/local-keystore');
    const ks = new KS();
    await expect(ks.load()).rejects.toThrow(/not valid JSON/i);
  });

  it('throws when keystore file does not exist', async () => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig({
        BTC_SIGNING_MODE: 'keystore_file',
        BTC_DEV_PRIVATE_KEY_WIF: undefined,
        BTC_KEYSTORE_PATH: path.join(tmpDir, 'nonexistent.json'),
        BTC_KEYSTORE_PASSWORD: 'any',
      }),
    }));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore: KS } = require('../src/keystore/local-keystore');
    const ks = new KS();
    await expect(ks.load()).rejects.toThrow(/Cannot read keystore/i);
  });
});

describe('LocalKeystore — encryptKey static method', () => {
  beforeAll(() => {
    jest.resetModules();
    jest.doMock('../src/config', () => ({
      config: makeMockConfig(),
    }));
  });

  it('produces a KeystoreFileEntry with all required fields', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore } = require('../src/keystore/local-keystore');
    const entry = LocalKeystore.encryptKey('btc:test:fp', 'btc', TEST_WIF, 'pw', 'regtest');
    expect(entry.fingerprint).toBe('btc:test:fp');
    expect(entry.chainType).toBe('btc');
    expect(entry.salt).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.iv).toMatch(/^[0-9a-f]{24}$/);
    expect(entry.tag).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.ciphertext.length).toBeGreaterThan(0);
  });

  it('produces unique salt and iv on each call (random)', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { LocalKeystore } = require('../src/keystore/local-keystore');
    const e1 = LocalKeystore.encryptKey('fp', 'btc', TEST_WIF, 'pw');
    const e2 = LocalKeystore.encryptKey('fp', 'btc', TEST_WIF, 'pw');
    expect(e1.salt).not.toBe(e2.salt);
    expect(e1.iv).not.toBe(e2.iv);
  });
});
