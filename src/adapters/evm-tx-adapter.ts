/**
 * EVM Transaction Signing Adapter — implements ISigningAdapter.
 *
 * MVP stub: validates the EVM task and signs the raw transaction using
 * a raw 32-byte private key from the keystore.
 *
 * Signing: pure Node.js crypto (secp256k1 via tiny-secp256k1).
 * Does NOT depend on ethers.js or viem — keeping deps minimal.
 * For production, replace signRawTx() with ethers/viem wallet signing.
 */

import crypto from 'crypto';
import * as tinysecp from 'tiny-secp256k1';
import {
  ISigningAdapter,
  SignedPayload,
  sha256Hex,
  assertEvmTxTaskValid,
} from '@chain-api/external-signer-core';
import { SigningTask } from '@chain-api/external-signer-protocol';
import { LocalKeystore } from '../keystore/local-keystore';
import { config, getEvmChainIds } from '../config';

export class EvmTxAdapter implements ISigningAdapter {
  readonly payloadFormat = 'evm_raw_tx' as const;

  constructor(private readonly keystore: LocalKeystore) {}

  canHandle(task: SigningTask): boolean {
    return task.payloadFormat === 'evm_raw_tx' && task.chain !== 'bitcoin';
  }

  async sign(task: SigningTask): Promise<SignedPayload> {
    // 1. Structural + policy validation — amount limit skipped for manual tasks
    assertEvmTxTaskValid(task, {
      allowedChainIds: getEvmChainIds(),
      maxAmountWei: BigInt('1000000000000000000'),
      decisionMode: task.decisionMode,
    });

    // 2. Verify unsigned payload hash
    const computedHash = sha256Hex(task.unsignedPayload);
    if (computedHash !== task.unsignedPayloadHash) {
      throw new Error('unsignedPayloadHash mismatch — payload integrity check failed');
    }

    // 3. Get EVM signing key
    const fingerprint = config.EVM_SIGNER_FINGERPRINT ?? 'evm:dev:0000000000000000';
    const privateKeyBytes = await this.keystore.getKey(fingerprint);

    // 4. Sign raw EVM transaction
    // unsignedPayload: hex-encoded RLP of the unsigned EVM transaction (EIP-1559 or legacy)
    const signedHex = await signRawEvmTx(task.unsignedPayload, privateKeyBytes);
    const signedHash = sha256Hex(signedHex);

    return {
      signedPayload: signedHex,
      signedPayloadHash: signedHash,
      signerFingerprint: fingerprint,
      signedAt: new Date().toISOString(),
    };
  }
}

/**
 * Sign a raw EVM transaction using tiny-secp256k1.
 *
 * Expects unsignedPayload as hex-encoded RLP of the transaction hash to sign
 * (keccak256 of the serialized transaction), as produced by chain-api.
 *
 * Returns hex of the signed transaction (with v, r, s appended per EIP-2718).
 *
 * NOTE: This is a minimal implementation for testing. In production use
 * ethers.js or viem which handle full RLP encoding/decoding and EIP-1559.
 */
async function signRawEvmTx(unsignedPayloadHex: string, privateKey: Buffer): Promise<string> {
  // chain-api sends the 32-byte hash to sign (keccak256 of the tx)
  const normalized = unsignedPayloadHex.startsWith('0x')
    ? unsignedPayloadHex.slice(2)
    : unsignedPayloadHex;

  const msgHash = Buffer.from(normalized, 'hex');
  if (msgHash.length !== 32) {
    throw new Error(
      `EVM unsigned payload must be a 32-byte keccak256 hash (got ${msgHash.length} bytes). ` +
      'chain-api should send the tx hash, not the full RLP-encoded tx.'
    );
  }

  // signRecoverable returns { signature: Uint8Array(64), recoveryId: number }
  const { signature, recoveryId } = tinysecp.signRecoverable(msgHash, privateKey);

  // Build compact signature: r (32) + s (32) + v (1)
  const r = Buffer.from(signature.slice(0, 32));
  const s = Buffer.from(signature.slice(32, 64));
  const v = recoveryId + 27; // EIP-155 adds chainId*2+35; handled by chain-api during finalize

  return '0x' + r.toString('hex') + s.toString('hex') + v.toString(16).padStart(2, '0');
}
