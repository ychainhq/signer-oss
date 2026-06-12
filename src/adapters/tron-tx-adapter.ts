import * as tinysecp from 'tiny-secp256k1';
import BIP32Factory from 'bip32';
import * as bitcoin from 'bitcoinjs-lib';
import {
  ISigningAdapter,
  SignedPayload,
  sha256Hex,
  assertTronTxTaskValid,
} from '@chain-api/external-signer-core';
import { SigningTask } from '@chain-api/external-signer-protocol';
import { LocalKeystore } from '../keystore/local-keystore';
import { config, getTronAllowedContracts } from '../config';

// Initialize ECC library (idempotent)
try { bitcoin.initEccLib(tinysecp as any); } catch { /* already initialized */ }
const bip32 = BIP32Factory(tinysecp as any);

interface TronPayloadEnvelope {
  chainId?: string;
  network?: string;
  type?: string;
  contractAddress?: string;
  amountRaw?: string;
  fromAddress?: string;
  toAddress?: string;
  derivationPath?: string;
  rawTransaction: {
    txID: string;
    raw_data: Record<string, unknown>;
    raw_data_hex: string;
    [key: string]: unknown;
  };
}

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

    const envelope = JSON.parse(task.unsignedPayload) as TronPayloadEnvelope;
    const { rawTransaction, derivationPath } = envelope;

    if (!rawTransaction?.txID) {
      throw new Error('unsignedPayload.rawTransaction.txID is missing');
    }

    const txIdBytes = Buffer.from(rawTransaction.txID, 'hex');
    if (txIdBytes.length !== 32) {
      throw new Error(`rawTransaction.txID must be 32 bytes (64 hex chars), got ${txIdBytes.length}`);
    }

    let privateKeyBytes: Buffer;
    let signerFingerprint: string;

    if (task.requestType === 'tron_sweep' && derivationPath) {
      // HD sweep: derive child key from account xprv
      const hdFingerprint = config.TRON_SIGNER_FINGERPRINT_HD ?? config.TRON_SIGNER_FINGERPRINT ?? 'tron:dev:0000000000000000';
      const xprv = this.keystore.getXprv(hdFingerprint);
      // Use mainnet network for xprv format (TRON has no separate network for HD keys)
      const accountNode = bip32.fromBase58(xprv, bitcoin.networks.bitcoin);
      const relPath = derivationPath.replace(/^m\//, '');
      const childNode = accountNode.derivePath(relPath);
      if (!childNode.privateKey) {
        throw new Error(`BIP32 derivation yielded no private key for path: ${derivationPath}`);
      }
      privateKeyBytes = Buffer.from(childNode.privateKey);
      signerFingerprint = hdFingerprint;
    } else {
      const fingerprint = config.TRON_SIGNER_FINGERPRINT ?? 'tron:dev:0000000000000000';
      privateKeyBytes = await this.keystore.getKey(fingerprint);
      signerFingerprint = fingerprint;
    }

    const sigHex = signTxId(txIdBytes, privateKeyBytes);

    // signedPayload is the complete TRON transaction ready for broadcast
    const signedTx = { ...rawTransaction, signature: [sigHex] };
    const signedPayload = JSON.stringify(signedTx);

    return {
      signedPayload,
      signedPayloadHash: sha256Hex(signedPayload),
      signerFingerprint,
      signedAt: new Date().toISOString(),
    };
  }
}

function signTxId(txIdBytes: Buffer, privateKey: Buffer): string {
  const { signature, recoveryId } = tinysecp.signRecoverable(txIdBytes, privateKey);
  return Buffer.concat([Buffer.from(signature), Buffer.from([recoveryId])]).toString('hex');
}
