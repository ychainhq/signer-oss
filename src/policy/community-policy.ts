/**
 * Community Policy Provider
 *
 * Evaluates whether a signing task should be auto-signed or rejected.
 * Reads limits from config (env vars).
 */

import { config, getAllowedDestinations } from '../config';

export interface PolicyEvalResult {
  approved: boolean;
  reason: string;
  errorCode?: string;
}

export function evaluateCommunityPolicy(task: {
  amountRaw: string;
  feeRateSatVb?: number | null;
  outputsCount?: number | null;
  expiresAt: string;
}): PolicyEvalResult {
  const now = new Date();

  // Check expiry
  if (new Date(task.expiresAt) <= now) {
    return { approved: false, reason: `Task expired at ${task.expiresAt}`, errorCode: 'task_expired' };
  }

  // Check amount
  const amount = BigInt(task.amountRaw);
  if (amount > config.MAX_AUTO_SIGN_AMOUNT_SATS) {
    return {
      approved: false,
      reason: `Amount ${task.amountRaw} sats exceeds auto-sign limit ${config.MAX_AUTO_SIGN_AMOUNT_SATS} sats`,
      errorCode: 'amount_exceeds_auto_limit',
    };
  }

  // Check fee rate
  if (task.feeRateSatVb !== null && task.feeRateSatVb !== undefined) {
    const feeRate = Number(task.feeRateSatVb);
    if (feeRate > config.MAX_FEE_RATE_SAT_VB) {
      return {
        approved: false,
        reason: `Fee rate ${feeRate} sat/vB exceeds limit ${config.MAX_FEE_RATE_SAT_VB} sat/vB`,
        errorCode: 'fee_rate_too_high',
      };
    }
  }

  // Check outputs count
  if (task.outputsCount !== null && task.outputsCount !== undefined) {
    if (task.outputsCount > config.MAX_OUTPUTS_PER_BATCH) {
      return {
        approved: false,
        reason: `Outputs count ${task.outputsCount} exceeds limit ${config.MAX_OUTPUTS_PER_BATCH}`,
        errorCode: 'outputs_count_exceeds_limit',
      };
    }
  }

  return { approved: true, reason: 'policy_passed' };
}
