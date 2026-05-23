/**
 * BTC PSBT Signing Adapter — implements ISigningAdapter.
 *
 * Validates and signs BTC PSBT transactions using bitcoinjs-lib + ecpair.
 * Local policy validation runs before any signing attempt.
 */

import crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import ECPairFactory from 'ecpair';
import * as tinysecp from 'tiny-secp256k1';
import {
  ISigningAdapter,
  SignedPayload,
  sha256Hex,
} from '@chain-api/external-signer-core';
import { SigningTask } from '@chain-api/external-signer-protocol';
import { LocalKeystore } from '../keystore/local-keystore';
import { evaluateCommunityPolicy } from '../policy/community-policy';
import { config } from '../config';

const ECPair = ECPairFactory(tinysecp);

function getBitcoinNetwork(): bitcoin.networks.Network {
  switch (config.BTC_NETWORK) {
    case 'mainnet': return bitcoin.networks.bitcoin;
    case 'testnet': return bitcoin.networks.testnet;
    case 'regtest': return bitcoin.networks.regtest;
    default: return bitcoin.networks.regtest;
  }
}

export class BtcPsbtAdapter implements ISigningAdapter {
  readonly payloadFormat = 'btc_psbt' as const;

  constructor(private readonly keystore: LocalKeystore) {}

  canHandle(task: SigningTask): boolean {
    return task.payloadFormat === 'btc_psbt' && task.chain === 'bitcoin';
  }

  async sign(task: SigningTask): Promise<SignedPayload> {
    // 1. Local policy check
    const policy = evaluateCommunityPolicy({
      amountRaw: task.amountRaw,
      feeRateSatVb: task.feeRateSatVb ?? undefined,
      outputsCount: task.outputsCount ?? undefined,
      expiresAt: task.expiresAt,
    });

    if (!policy.approved) {
      const err = new Error(policy.reason) as NodeJS.ErrnoException & { code?: string };
      err.code = policy.errorCode ?? 'signer_policy_rejected';
      throw err;
    }

    // 2. Verify unsigned payload hash
    const computedHash = sha256Hex(task.unsignedPayload);
    if (computedHash !== task.unsignedPayloadHash) {
      throw new Error('unsignedPayloadHash mismatch — payload integrity check failed');
    }

    // 3. Get signing key
    const fingerprint = config.SIGNER_FINGERPRINT;
    const wif = this.keystore.getWif(fingerprint);
    const network = getBitcoinNetwork();
    const keyPair = ECPair.fromWIF(wif, network);

    // 4. Parse and sign PSBT
    let psbt: bitcoin.Psbt;
    try {
      psbt = bitcoin.Psbt.fromBase64(task.unsignedPayload, { network });
    } catch (err) {
      throw new Error(`Failed to parse PSBT: ${String(err)}`);
    }

    try {
      psbt.signAllInputs(keyPair);
      psbt.finalizeAllInputs();
    } catch (err) {
      throw new Error(`PSBT signing failed: ${String(err)}`);
    }

    const signedBase64 = psbt.toBase64();
    const signedHash = sha256Hex(signedBase64);

    return {
      signedPayload: signedBase64,
      signedPayloadHash: signedHash,
      signerFingerprint: fingerprint,
      signedAt: new Date().toISOString(),
    };
  }
}
