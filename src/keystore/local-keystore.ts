/**
 * LocalKeystore — simple key management for OSS signer.
 *
 * Two modes:
 * 1. dev_env_key: reads WIF key from BTC_DEV_PRIVATE_KEY_WIF env var.
 *    For development/testing ONLY.
 * 2. keystore_file: reads from an encrypted keystore file.
 *    Not fully implemented — extend for production use.
 *
 * WARNING: Do NOT use dev_env_key in production with real funds.
 */

import { config } from '../config';

export interface KeystoreEntry {
  fingerprint: string;
  wif: string;             // WIF-encoded private key
  network: string;
}

export class LocalKeystore {
  private keys: Map<string, KeystoreEntry> = new Map();

  async load(): Promise<void> {
    if (config.BTC_SIGNING_MODE === 'dev_env_key') {
      const wif = config.BTC_DEV_PRIVATE_KEY_WIF;
      if (!wif) {
        throw new Error('BTC_DEV_PRIVATE_KEY_WIF is required when BTC_SIGNING_MODE=dev_env_key');
      }

      const fingerprint = config.SIGNER_FINGERPRINT;
      this.keys.set(fingerprint, {
        fingerprint,
        wif,
        network: config.BTC_NETWORK,
      });

      process.stdout.write(`[keystore] Loaded dev key (fingerprint: ${fingerprint})\n`);
    } else if (config.BTC_SIGNING_MODE === 'keystore_file') {
      // TODO: implement encrypted keystore file loading
      throw new Error('keystore_file mode not yet implemented — use dev_env_key for development');
    } else {
      throw new Error(`Unknown BTC_SIGNING_MODE: ${config.BTC_SIGNING_MODE}`);
    }
  }

  getKey(fingerprint: string): KeystoreEntry | undefined {
    return this.keys.get(fingerprint);
  }

  listFingerprints(): string[] {
    return Array.from(this.keys.keys());
  }

  isHealthy(): boolean {
    return this.keys.size > 0;
  }
}
