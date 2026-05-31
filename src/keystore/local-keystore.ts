/**
 * LocalKeystore — implements IKeyProvider for the OSS signer.
 *
 * Supports two key types:
 * - BTC: WIF-encoded private key (stored in KeystoreEntry, returned as raw 32-byte Buffer)
 * - EVM: raw hex private key (returned as raw 32-byte Buffer)
 *
 * Two loading modes:
 * - dev_env_key: reads from env vars. Development ONLY — never use with real funds.
 * - keystore_file: reads from AES-256-GCM encrypted JSON file (PBKDF2 key derivation).
 */

import fs from 'fs/promises';
import crypto from 'crypto';
import { IKeyProvider } from '@chain-api/external-signer-core';
import { config } from '../config';

interface KeystoreEntry {
  fingerprint: string;
  rawPrivateKey: Buffer;  // 32 bytes for btc/evm; unused for btc_hd (use xprv directly)
  chainType: 'btc' | 'btc_hd' | 'evm';
  network?: string;       // BTC only: mainnet | testnet | regtest
  wif?: string;           // btc only: kept for adapters that need WIF directly
  xprv?: string;          // btc_hd only: account-level xprv (Base58Check encoded)
}

export interface KeystoreFileEntry {
  fingerprint: string;
  chainType: 'btc' | 'btc_hd' | 'evm';
  network?: string;
  salt: string;       // hex-encoded, 32 bytes
  iv: string;         // hex-encoded, 12 bytes
  tag: string;        // hex-encoded, 16 bytes
  ciphertext: string; // hex-encoded — for btc_hd: plaintext is the xprv Base58Check string
}

export interface KeystoreFile {
  version: 1;
  keys: KeystoreFileEntry[];
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
}

export class LocalKeystore implements IKeyProvider {
  private keys: Map<string, KeystoreEntry> = new Map();

  async load(): Promise<void> {
    if (config.BTC_SIGNING_MODE === 'dev_env_key') {
      await this.loadDevEnvKeys();
    } else if (config.BTC_SIGNING_MODE === 'keystore_file') {
      await this.loadKeystoreFile();
    } else {
      throw new Error(`Unknown BTC_SIGNING_MODE: ${config.BTC_SIGNING_MODE}`);
    }
  }

  private async loadDevEnvKeys(): Promise<void> {
    // BTC single-key (WIF) — for withdrawal batch signing
    const wif = config.BTC_DEV_PRIVATE_KEY_WIF;
    if (wif) {
      const rawBtc = wifToPrivateKeyBuffer(wif);
      const fingerprint = config.SIGNER_FINGERPRINT;
      this.keys.set(fingerprint, {
        fingerprint,
        rawPrivateKey: rawBtc,
        chainType: 'btc',
        network: config.BTC_NETWORK,
        wif,
      });
      process.stdout.write(`[keystore] BTC dev key loaded (fingerprint: ${fingerprint})\n`);
    }

    // BTC HD key (account xprv) — for sweep signing (multi-input, one key per deposit address)
    const xprv = config.BTC_DEV_ACCOUNT_XPRV;
    if (xprv) {
      const fingerprint = config.SIGNER_FINGERPRINT_HD ?? config.SIGNER_FINGERPRINT;
      this.keys.set(fingerprint, {
        fingerprint,
        rawPrivateKey: Buffer.alloc(32), // unused for btc_hd — getXprv() returns xprv string
        chainType: 'btc_hd',
        network: config.BTC_NETWORK,
        xprv,
      });
      process.stdout.write(`[keystore] BTC HD account key loaded (fingerprint: ${fingerprint})\n`);
    }

    // EVM key from hex (optional)
    const evmHex = config.EVM_DEV_PRIVATE_KEY_HEX;
    if (evmHex) {
      const normalized = evmHex.startsWith('0x') ? evmHex.slice(2) : evmHex;
      if (normalized.length !== 64) {
        throw new Error('EVM_DEV_PRIVATE_KEY_HEX must be a 32-byte hex string (64 hex chars)');
      }
      const rawEvm = Buffer.from(normalized, 'hex');
      const fingerprint = config.EVM_SIGNER_FINGERPRINT ?? 'evm:dev:0000000000000000';
      this.keys.set(fingerprint, {
        fingerprint,
        rawPrivateKey: rawEvm,
        chainType: 'evm',
      });
      process.stdout.write(`[keystore] EVM dev key loaded (fingerprint: ${fingerprint})\n`);
    }

    if (this.keys.size === 0) {
      throw new Error(
        'No signing keys loaded. Set BTC_DEV_PRIVATE_KEY_WIF and/or EVM_DEV_PRIVATE_KEY_HEX'
      );
    }
  }

  private async loadKeystoreFile(): Promise<void> {
    const keystorePath = config.BTC_KEYSTORE_PATH;
    const password = config.BTC_KEYSTORE_PASSWORD;
    if (!keystorePath) throw new Error('BTC_KEYSTORE_PATH is required for keystore_file mode');
    if (!password) throw new Error('BTC_KEYSTORE_PASSWORD is required for keystore_file mode');

    let raw: string;
    try {
      raw = await fs.readFile(keystorePath, 'utf8');
    } catch (err: any) {
      throw new Error(`Cannot read keystore file at ${keystorePath}: ${err.message}`);
    }

    let file: KeystoreFile;
    try {
      file = JSON.parse(raw) as KeystoreFile;
    } catch {
      throw new Error(`Keystore file at ${keystorePath} is not valid JSON`);
    }

    if (file.version !== 1) {
      throw new Error(`Unsupported keystore file version: ${file.version}`);
    }

    for (const entry of file.keys) {
      const salt = Buffer.from(entry.salt, 'hex');
      const iv = Buffer.from(entry.iv, 'hex');
      const tag = Buffer.from(entry.tag, 'hex');
      const ciphertext = Buffer.from(entry.ciphertext, 'hex');

      const aesKey = deriveKey(password, salt);
      const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey, iv);
      decipher.setAuthTag(tag);

      let plaintext: string;
      try {
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      } catch {
        throw new Error(
          `Failed to decrypt key '${entry.fingerprint}' — wrong password or corrupted file`
        );
      }

      if (entry.chainType === 'btc') {
        const rawBtc = wifToPrivateKeyBuffer(plaintext);
        this.keys.set(entry.fingerprint, {
          fingerprint: entry.fingerprint,
          rawPrivateKey: rawBtc,
          chainType: 'btc',
          network: entry.network,
          wif: plaintext,
        });
      } else if (entry.chainType === 'btc_hd') {
        // plaintext is the account xprv Base58Check string
        this.keys.set(entry.fingerprint, {
          fingerprint: entry.fingerprint,
          rawPrivateKey: Buffer.alloc(32), // unused for btc_hd
          chainType: 'btc_hd',
          network: entry.network,
          xprv: plaintext,
        });
      } else {
        const normalized = plaintext.startsWith('0x') ? plaintext.slice(2) : plaintext;
        if (normalized.length !== 64) {
          throw new Error(`Key '${entry.fingerprint}': EVM plaintext must be 32-byte hex (64 chars)`);
        }
        this.keys.set(entry.fingerprint, {
          fingerprint: entry.fingerprint,
          rawPrivateKey: Buffer.from(normalized, 'hex'),
          chainType: 'evm',
        });
      }

      process.stdout.write(`[keystore] Key loaded from file: ${entry.fingerprint} (${entry.chainType})\n`);
    }

    if (this.keys.size === 0) {
      throw new Error('Keystore file contains no keys');
    }
  }

  // IKeyProvider — returns raw 32-byte private key buffer
  async getKey(fingerprint: string): Promise<Buffer> {
    const entry = this.keys.get(fingerprint);
    if (!entry) {
      throw new Error(`Key not found for fingerprint: ${fingerprint}`);
    }
    return entry.rawPrivateKey;
  }

  async listFingerprints(): Promise<string[]> {
    return Array.from(this.keys.keys());
  }

  async isHealthy(): Promise<boolean> {
    return this.keys.size > 0;
  }

  // BTC adapters may need WIF directly — convenience getter
  getWif(fingerprint: string): string {
    const entry = this.keys.get(fingerprint);
    if (!entry || !entry.wif) {
      throw new Error(`No WIF key for fingerprint: ${fingerprint}`);
    }
    return entry.wif;
  }

  // HD sweep signing — returns account xprv for child-key derivation
  getXprv(fingerprint: string): string {
    const entry = this.keys.get(fingerprint);
    if (!entry || entry.chainType !== 'btc_hd' || !entry.xprv) {
      throw new Error(
        `No HD account xprv for fingerprint: ${fingerprint}. ` +
        'Set BTC_DEV_ACCOUNT_XPRV (dev) or add a btc_hd entry to the keystore file.'
      );
    }
    return entry.xprv;
  }

  getChainType(fingerprint: string): 'btc' | 'btc_hd' | 'evm' {
    const entry = this.keys.get(fingerprint);
    if (!entry) throw new Error(`Key not found: ${fingerprint}`);
    return entry.chainType;
  }

  listFingerprintsSync(): string[] {
    return Array.from(this.keys.keys());
  }

  /**
   * CLI helper: encrypt a single key for inclusion in a keystore file.
   *
   * Usage (generate keystore file):
   *   const entry = LocalKeystore.encryptKey('btc:mainnet:abc', 'btc', wif, password, 'mainnet');
   *   const file = { version: 1, keys: [entry] };
   *   fs.writeFileSync('keystore.json', JSON.stringify(file, null, 2));
   */
  static encryptKey(
    fingerprint: string,
    chainType: 'btc' | 'btc_hd' | 'evm',
    plaintext: string,
    password: string,
    network?: string
  ): KeystoreFileEntry {
    const salt = crypto.randomBytes(32);
    const iv = crypto.randomBytes(12);
    const aesKey = deriveKey(password, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      fingerprint,
      chainType,
      network,
      salt: salt.toString('hex'),
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ciphertext.toString('hex'),
    };
  }
}

/**
 * Decode WIF to raw 32-byte private key without importing ecpair.
 * WIF is: version (1 byte) + key (32 bytes) + [compression flag (1 byte)] + checksum (4 bytes).
 * Base58Check encoded.
 */
function wifToPrivateKeyBuffer(wif: string): Buffer {
  const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base58Decode = (str: string): Buffer => {
    let num = BigInt(0);
    for (const char of str) {
      const idx = ALPHABET.indexOf(char);
      if (idx < 0) throw new Error(`Invalid base58 character: ${char}`);
      num = num * BigInt(58) + BigInt(idx);
    }
    const hex = num.toString(16).padStart(2, '0');
    const padded = hex.length % 2 ? '0' + hex : hex;
    const bytes = Buffer.from(padded, 'hex');
    // Restore leading zero bytes
    let leadingZeros = 0;
    for (const char of str) {
      if (char === '1') leadingZeros++;
      else break;
    }
    return Buffer.concat([Buffer.alloc(leadingZeros), bytes]);
  };

  const decoded = base58Decode(wif);
  // decoded: [version (1)] [key (32)] [compressed flag? (1)] [checksum (4)]
  // For compressed WIF: total 38 bytes. Uncompressed: 37 bytes.
  const keyBytes = decoded.slice(1, 33);
  if (keyBytes.length !== 32) {
    throw new Error('Failed to decode WIF: unexpected key length');
  }
  return keyBytes;
}
