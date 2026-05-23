/**
 * BTC PSBT Signing Adapter
 *
 * Signs BTC PSBT transactions using bitcoinjs-lib.
 * Performs local policy validation before signing.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { LocalKeystore } from '../keystore/local-keystore';
import { evaluateCommunityPolicy } from '../policy/community-policy';
import { config } from '../config';

export interface SignTaskInput {
  taskId: string;
  unsignedPayload: string;      // base64 PSBT
  unsignedPayloadHash: string;  // SHA-256 of unsignedPayload
  amountRaw: string;
  feeRateSatVb?: number | null;
  outputsCount?: number | null;
  expiresAt: string;
}

export interface SignTaskResult {
  signedPayload: string;
  signedPayloadHash: string;
  signerFingerprint: string;
  signedAt: string;
}

function getBitcoinNetwork(): bitcoin.networks.Network {
  switch (config.BTC_NETWORK) {
    case 'mainnet': return bitcoin.networks.bitcoin;
    case 'testnet': return bitcoin.networks.testnet;
    case 'regtest': return bitcoin.networks.regtest;
    default: return bitcoin.networks.regtest;
  }
}

export class BtcPsbtAdapter {
  private keystore: LocalKeystore;

  constructor(keystore: LocalKeystore) {
    this.keystore = keystore;
  }

  /**
   * Validate and sign a PSBT.
   * Throws if policy fails or key not found.
   */
  async sign(task: SignTaskInput): Promise<SignTaskResult> {
    // 1. Policy check
    const policy = evaluateCommunityPolicy({
      amountRaw: task.amountRaw,
      feeRateSatVb: task.feeRateSatVb,
      outputsCount: task.outputsCount,
      expiresAt: task.expiresAt,
    });

    if (!policy.approved) {
      const err = new Error(policy.reason) as any;
      err.code = policy.errorCode ?? 'signer_policy_rejected';
      throw err;
    }

    // 2. Verify payload hash
    const computedHash = crypto
      .createHash('sha256')
      .update(task.unsignedPayload)
      .digest('hex');

    if (computedHash !== task.unsignedPayloadHash) {
      throw new Error('unsignedPayloadHash mismatch — payload integrity check failed');
    }

    // 3. Get signing key
    const fingerprint = config.SIGNER_FINGERPRINT;
    const keyEntry = this.keystore.getKey(fingerprint);
    if (!keyEntry) {
      throw new Error(`No key found for fingerprint: ${fingerprint}`);
    }

    // 4. Sign PSBT
    const network = getBitcoinNetwork();

    let psbt: bitcoin.Psbt;
    try {
      psbt = bitcoin.Psbt.fromBase64(task.unsignedPayload, { network });
    } catch (err) {
      throw new Error(`Failed to parse PSBT: ${String(err)}`);
    }

    // Import WIF key
    const keyPair = bitcoin.ECPair
      ? bitcoin.ECPair.fromWIF(keyEntry.wif, network)
      : (() => { throw new Error('ECPair not available — install ecpair package'); })();

    try {
      psbt.signAllInputs(keyPair);
      psbt.finalizeAllInputs();
    } catch (err) {
      throw new Error(`PSBT signing failed: ${String(err)}`);
    }

    const signedBase64 = psbt.toBase64();
    const signedHash = crypto.createHash('sha256').update(signedBase64).digest('hex');
    const signedAt = new Date().toISOString();

    return {
      signedPayload: signedBase64,
      signedPayloadHash: signedHash,
      signerFingerprint: fingerprint,
      signedAt,
    };
  }
}
