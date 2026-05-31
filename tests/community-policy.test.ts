/**
 * community-policy tests.
 * evaluateCommunityPolicy() reads from config (parsed from process.env at module load),
 * so we mock the config module to control limits in each describe block.
 */

jest.mock('../src/config', () => ({
  config: {
    MAX_AUTO_SIGN_AMOUNT_SATS: 1_000_000n,
    MAX_FEE_RATE_SAT_VB: 50,
    MAX_OUTPUTS_PER_BATCH: 200,
    ALLOWED_DESTINATIONS: '',
  },
  getAllowedDestinations: () => [],
}));

import { evaluateCommunityPolicy } from '../src/policy/community-policy';

const FUTURE = new Date(Date.now() + 60_000).toISOString();
const PAST   = new Date(Date.now() - 60_000).toISOString();

function makeInput(overrides: Partial<{
  amountRaw: string;
  feeRateSatVb: number | null;
  outputsCount: number | null;
  expiresAt: string;
  decisionMode: 'auto' | 'manual';
}> = {}) {
  return {
    amountRaw: '100000',
    feeRateSatVb: 10,
    outputsCount: 2,
    expiresAt: FUTURE,
    ...overrides,
  };
}

describe('evaluateCommunityPolicy', () => {
  it('approves a task within all limits', () => {
    const result = evaluateCommunityPolicy(makeInput());
    expect(result.approved).toBe(true);
    expect(result.reason).toBe('policy_passed');
  });

  it('rejects expired task', () => {
    const result = evaluateCommunityPolicy(makeInput({ expiresAt: PAST }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('task_expired');
    expect(result.reason).toMatch(/expired/i);
  });

  it('rejects amount above MAX_AUTO_SIGN_AMOUNT_SATS', () => {
    const result = evaluateCommunityPolicy(makeInput({ amountRaw: '1000001' }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('amount_exceeds_auto_limit');
  });

  it('approves amount exactly at MAX_AUTO_SIGN_AMOUNT_SATS', () => {
    const result = evaluateCommunityPolicy(makeInput({ amountRaw: '1000000' }));
    expect(result.approved).toBe(true);
  });

  it('rejects feeRateSatVb above MAX_FEE_RATE_SAT_VB', () => {
    const result = evaluateCommunityPolicy(makeInput({ feeRateSatVb: 51 }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('fee_rate_too_high');
    expect(result.reason).toMatch(/fee rate/i);
  });

  it('approves feeRateSatVb exactly at MAX_FEE_RATE_SAT_VB', () => {
    const result = evaluateCommunityPolicy(makeInput({ feeRateSatVb: 50 }));
    expect(result.approved).toBe(true);
  });

  it('skips fee check when feeRateSatVb is null', () => {
    const result = evaluateCommunityPolicy(makeInput({ feeRateSatVb: null }));
    expect(result.approved).toBe(true);
  });

  it('rejects outputsCount above MAX_OUTPUTS_PER_BATCH', () => {
    const result = evaluateCommunityPolicy(makeInput({ outputsCount: 201 }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('outputs_count_exceeds_limit');
    expect(result.reason).toMatch(/outputs/i);
  });

  it('approves outputsCount exactly at MAX_OUTPUTS_PER_BATCH', () => {
    const result = evaluateCommunityPolicy(makeInput({ outputsCount: 200 }));
    expect(result.approved).toBe(true);
  });

  it('skips outputs check when outputsCount is null', () => {
    const result = evaluateCommunityPolicy(makeInput({ outputsCount: null }));
    expect(result.approved).toBe(true);
  });

  it('expiry is checked before amount (expiry takes priority)', () => {
    // Both expired AND amount exceeded — should fail with expiry code
    const result = evaluateCommunityPolicy(makeInput({
      expiresAt: PAST,
      amountRaw: '9999999',
    }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('task_expired');
  });
});

describe('evaluateCommunityPolicy — decisionMode: manual', () => {
  it('approves amount exceeding auto-sign limit when decisionMode is manual', () => {
    // 5 BTC — well above the 1M sats limit, but operator already approved
    const result = evaluateCommunityPolicy(makeInput({
      amountRaw: '500000000',
      decisionMode: 'manual',
    }));
    expect(result.approved).toBe(true);
  });

  it('approves high fee rate when decisionMode is manual', () => {
    const result = evaluateCommunityPolicy(makeInput({
      feeRateSatVb: 999,
      decisionMode: 'manual',
    }));
    expect(result.approved).toBe(true);
  });

  it('approves high outputs count when decisionMode is manual', () => {
    const result = evaluateCommunityPolicy(makeInput({
      outputsCount: 9999,
      decisionMode: 'manual',
    }));
    expect(result.approved).toBe(true);
  });

  it('still rejects expired task even when decisionMode is manual', () => {
    const result = evaluateCommunityPolicy(makeInput({
      expiresAt: PAST,
      amountRaw: '500000000',
      decisionMode: 'manual',
    }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('task_expired');
  });

  it('auto mode (undefined decisionMode) still enforces amount limit', () => {
    const result = evaluateCommunityPolicy(makeInput({ amountRaw: '1000001' }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('amount_exceeds_auto_limit');
  });

  it('explicit decisionMode auto still enforces amount limit', () => {
    const result = evaluateCommunityPolicy(makeInput({
      amountRaw: '1000001',
      decisionMode: 'auto',
    }));
    expect(result.approved).toBe(false);
    expect(result.errorCode).toBe('amount_exceeds_auto_limit');
  });
});
