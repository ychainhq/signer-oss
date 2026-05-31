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
import BIP32Factory from 'bip32';
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
const bip32 = BIP32Factory(tinysecp);

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
    // 1. Local policy check — business limits skipped for manual tasks (operator already approved)
    const policy = evaluateCommunityPolicy({
      amountRaw: task.amountRaw,
      feeRateSatVb: task.feeRateSatVb ?? undefined,
      outputsCount: task.outputsCount ?? undefined,
      expiresAt: task.expiresAt,
      decisionMode: task.decisionMode,
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

    const network = getBitcoinNetwork();

    if (task.requestType === 'btc_sweep') {
      return this.signSweepPsbt(task, network);
    }
    return this.signWithdrawalPsbt(task, network);
  }

  // HD signing — one child key per PSBT input, derived from account xprv using bip32Derivation hints
  private async signSweepPsbt(task: SigningTask, network: bitcoin.networks.Network): Promise<SignedPayload> {
    const hdFingerprint = config.SIGNER_FINGERPRINT_HD ?? config.SIGNER_FINGERPRINT;
    const xprv = this.keystore.getXprv(hdFingerprint);
    const accountNode = bip32.fromBase58(xprv, network);

    let psbt: bitcoin.Psbt;
    try {
      psbt = bitcoin.Psbt.fromBase64(task.unsignedPayload, { network });
    } catch (err) {
      throw new Error(`Failed to parse sweep PSBT: ${String(err)}`);
    }

    try {
      for (let i = 0; i < psbt.data.inputs.length; i++) {
        const bip32Derivs = psbt.data.inputs[i].bip32Derivation;
        if (!bip32Derivs?.length) {
          throw new Error(
            `Sweep PSBT input ${i} missing bip32Derivation — ` +
            'engine must enrich PSBT before creating signing task'
          );
        }
        // Path is relative to account xpub, e.g. "m/0/3"
        const path = bip32Derivs[0].path;
        const childNode = accountNode.derivePath(path);
        const childPair = ECPair.fromPrivateKey(
          Buffer.from(childNode.privateKey!), { network }
        );
        psbt.signInput(i, childPair);
      }
      psbt.finalizeAllInputs();
    } catch (err) {
      throw new Error(`Sweep PSBT signing failed: ${String(err)}`);
    }

    const signedBase64 = psbt.toBase64();
    return {
      signedPayload: signedBase64,
      signedPayloadHash: sha256Hex(signedBase64),
      signerFingerprint: hdFingerprint,
      signedAt: new Date().toISOString(),
    };
  }

  // Single-key signing — for withdrawal batches (all inputs from hot wallet)
  private async signWithdrawalPsbt(task: SigningTask, network: bitcoin.networks.Network): Promise<SignedPayload> {
    const fingerprint = config.SIGNER_FINGERPRINT;
    const wif = this.keystore.getWif(fingerprint);
    const keyPair = ECPair.fromWIF(wif, network);

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
    return {
      signedPayload: signedBase64,
      signedPayloadHash: sha256Hex(signedBase64),
      signerFingerprint: fingerprint,
      signedAt: new Date().toISOString(),
    };
  }
}
