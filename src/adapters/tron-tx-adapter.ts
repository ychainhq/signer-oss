import crypto from 'crypto';
import * as tinysecp from 'tiny-secp256k1';
import {
  ISigningAdapter,
  SignedPayload,
  sha256Hex,
  assertTronTxTaskValid,
} from '@chain-api/external-signer-core';
import { SigningTask } from '@chain-api/external-signer-protocol';
import { LocalKeystore } from '../keystore/local-keystore';
import { config, getTronAllowedContracts } from '../config';

export class TronTxAdapter implements ISigningAdapter {
  readonly payloadFormat = 'tron_raw_tx' as const;

  constructor(private readonly keystore: LocalKeystore) {}

  canHandle(task: SigningTask): boolean {
    return task.payloadFormat === 'tron_raw_tx' && task.chain === 'tron';
  }

  async sign(task: SigningTask): Promise<SignedPayload> {
    assertTronTxTaskValid(task, {
      allowedNetworks: [config.TRON_NETWORK],
      allowedContracts: getTronAllowedContracts(),
      maxAmountSun: config.MAX_AUTO_SIGN_AMOUNT_SUN,
      maxFeeLimitSun: config.MAX_TRON_FEE_LIMIT_SUN,
      decisionMode: task.decisionMode,
    });

    const computedHash = sha256Hex(task.unsignedPayload);
    if (computedHash !== task.unsignedPayloadHash) {
      throw new Error('unsignedPayloadHash mismatch — payload integrity check failed');
    }

    const fingerprint = config.TRON_SIGNER_FINGERPRINT ?? 'tron:dev:0000000000000000';
    const privateKeyBytes = await this.keystore.getKey(fingerprint);
    const signature = signPayloadHash(computedHash, privateKeyBytes);
    const signedPayload = JSON.stringify({
      unsignedPayload: JSON.parse(task.unsignedPayload),
      signature,
      signerFingerprint: fingerprint,
    });

    return {
      signedPayload,
      signedPayloadHash: sha256Hex(signedPayload),
      signerFingerprint: fingerprint,
      signedAt: new Date().toISOString(),
    };
  }
}

function signPayloadHash(payloadHashHex: string, privateKey: Buffer): string {
  const msgHash = Buffer.from(payloadHashHex, 'hex');
  const { signature, recoveryId } = tinysecp.signRecoverable(msgHash, privateKey);
  return Buffer.concat([Buffer.from(signature), Buffer.from([recoveryId])]).toString('hex');
}
