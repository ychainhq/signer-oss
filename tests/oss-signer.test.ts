/**
 * OssSigner integration tests.
 * Tests the full processTask() flow: adapter selection → claim → sign → submit/reject/skip.
 * All external dependencies are mocked; only the flow logic under test is real.
 */

import type { SigningTask } from '@chain-api/external-signer-protocol';

// ── Mocks (hoisted before imports) ──────────────────────────────────────────

const mockHeartbeat    = jest.fn().mockResolvedValue({});
const mockListTasks    = jest.fn().mockResolvedValue([]);
const mockClaimTask    = jest.fn();
const mockSubmitTask   = jest.fn().mockResolvedValue({});
const mockRejectTask   = jest.fn().mockResolvedValue({});
const mockAuditLog     = jest.fn().mockResolvedValue(undefined);
const mockKeystoreLoad = jest.fn().mockResolvedValue(undefined);
const mockIsHealthy    = jest.fn().mockResolvedValue(true);
const mockListFps      = jest.fn().mockResolvedValue(['btc:fp:001']);
const mockHealthStart  = jest.fn().mockResolvedValue(undefined);
const mockHealthStop   = jest.fn().mockResolvedValue(undefined);

jest.mock('../src/config', () => ({
  config: {
    CHAIN_API_BASE_URL: 'https://chain-api.test.local',
    TENANT_ID: 'tenant-test',
    SIGNER_ID: 'oss-signer-test',
    SIGNER_NAME: 'Test OSS Signer',
    SIGNER_API_KEY: 'test-key',
    POLL_INTERVAL_MS: 60000,
    TASK_BATCH_SIZE: 5,
    BTC_SIGNING_MODE: 'dev_env_key',
    BTC_DEV_PRIVATE_KEY_WIF: undefined,
    SIGNER_FINGERPRINT: 'btc:fp:001',
    MAX_AUTO_SIGN_AMOUNT_SATS: 1_000_000n,
    MAX_FEE_RATE_SAT_VB: 50,
    MAX_OUTPUTS_PER_BATCH: 200,
    ALLOWED_DESTINATIONS: '',
    SIGNER_AUTO_ENROLL: false,
    SIGNER_PORT: 13300,
    SIGNER_BIND_HOST: '127.0.0.1',
    SUPPORTED_CHAINS: 'bitcoin',
    SUPPORTED_ASSETS: 'bitcoin:BTC',
    SUPPORTED_FORMATS: 'btc_psbt',
    AUDIT_LOG_FILE: '/tmp/test-audit.log',
    AUDIT_STDOUT: false,
    EVM_CHAIN_IDS: undefined,
    EVM_SIGNER_FINGERPRINT: undefined,
  },
  getSupportedChains:    () => ['bitcoin'],
  getSupportedAssets:    () => ['bitcoin:BTC'],
  getSupportedFormats:   () => ['btc_psbt'],
  getAllowedDestinations: () => [],
  getFallbackUrls:       () => [],
  getEvmChainIds:        () => [],
  isEvmEnabled:          () => false,
}));

jest.mock('../src/keystore/local-keystore', () => ({
  LocalKeystore: jest.fn().mockImplementation(() => ({
    load: mockKeystoreLoad,
    isHealthy: mockIsHealthy,
    listFingerprints: mockListFps,
    getWif: jest.fn().mockImplementation(() => { throw new Error('not needed in this test'); }),
    getKey: jest.fn().mockRejectedValue(new Error('not needed')),
  })),
}));

const mockBtcCanHandle = jest.fn().mockReturnValue(true);
const mockBtcSign      = jest.fn().mockResolvedValue({
  signedPayload: 'signed-psbt-base64',
  signedPayloadHash: 'signed-hash',
  signerFingerprint: 'btc:fp:001',
  signedAt: new Date().toISOString(),
});

jest.mock('../src/adapters/btc-psbt-adapter', () => ({
  BtcPsbtAdapter: jest.fn().mockImplementation(() => ({
    payloadFormat: 'btc_psbt',
    canHandle: mockBtcCanHandle,
    sign: mockBtcSign,
  })),
}));

jest.mock('../src/adapters/evm-tx-adapter', () => ({
  EvmTxAdapter: jest.fn().mockImplementation(() => ({
    payloadFormat: 'evm_raw_tx',
    canHandle: jest.fn().mockReturnValue(false),
    sign: jest.fn().mockResolvedValue({}),
  })),
}));

jest.mock('../src/audit/local-audit-sink', () => ({
  LocalAuditSink: jest.fn().mockImplementation(() => ({
    log: mockAuditLog,
  })),
}));

jest.mock('../src/health-server', () => ({
  HealthServer: jest.fn().mockImplementation(() => ({
    start: mockHealthStart,
    stop:  mockHealthStop,
  })),
}));

jest.mock('@chain-api/external-signer-core', () => {
  const actual = jest.requireActual<typeof import('@chain-api/external-signer-core')>(
    '@chain-api/external-signer-core',
  );
  return {
    ...actual,
    SignerApiClient: jest.fn().mockImplementation(() => ({
      heartbeat:  mockHeartbeat,
      listTasks:  mockListTasks,
      claimTask:  mockClaimTask,
      submitTask: mockSubmitTask,
      rejectTask: mockRejectTask,
    })),
  };
});

import { OssSigner } from '../src/signer';

// ── Test helper ──────────────────────────────────────────────────────────────

/** Expose protected processTask() for direct invocation in tests. */
class TestableSigner extends OssSigner {
  callProcessTask(task: SigningTask) {
    return (this as unknown as { processTask(t: SigningTask): Promise<string> }).processTask(task);
  }
}

function makeTask(overrides: Partial<SigningTask> = {}): SigningTask {
  return {
    id: 'task-001',
    tenantId: 'tenant-test',
    signerId: 'oss-signer-test',
    requestType: 'withdrawal',
    chain: 'bitcoin',
    assetId: 'bitcoin:BTC',
    payloadFormat: 'btc_psbt',
    unsignedPayload: 'cHNidA==',
    unsignedPayloadHash: 'abc123',
    amountRaw: '50000',
    feeRateSatVb: 10,
    outputsCount: 1,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'available',
    decisionMode: 'auto',
    retryCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    signerFingerprint: null,
    claimedAt: null,
    signedAt: null,
    ...overrides,
  } as SigningTask;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('OssSigner — processTask() flow', () => {
  let signer: TestableSigner;

  beforeEach(() => {
    jest.clearAllMocks();
    mockClaimTask.mockResolvedValue(makeTask({ status: 'claimed', claimedAt: new Date().toISOString() }));
    signer = new TestableSigner();
  });

  describe('happy path — sign and submit', () => {
    it('returns "signed" when adapter handles, claims, and signs successfully', async () => {
      const result = await signer.callProcessTask(makeTask());
      expect(result).toBe('signed');
    });

    it('calls claimTask() before signing', async () => {
      await signer.callProcessTask(makeTask());
      expect(mockClaimTask).toHaveBeenCalledWith('task-001');
    });

    it('calls submitTask() with signed payload', async () => {
      await signer.callProcessTask(makeTask());
      expect(mockSubmitTask).toHaveBeenCalledWith(
        'task-001',
        expect.objectContaining({ signedPayload: 'signed-psbt-base64' })
      );
    });

    it('logs a signing_signed audit event', async () => {
      await signer.callProcessTask(makeTask());
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'signing_signed', taskId: 'task-001' })
      );
    });
  });

  describe('no adapter found', () => {
    beforeEach(() => {
      mockBtcCanHandle.mockReturnValue(false);
    });

    afterEach(() => {
      mockBtcCanHandle.mockReturnValue(true);
    });

    it('returns "rejected" when no adapter can handle the task', async () => {
      const result = await signer.callProcessTask(makeTask({ payloadFormat: 'evm_raw_tx' }));
      expect(result).toBe('rejected');
    });

    it('calls rejectTask() with signer_internal_error', async () => {
      await signer.callProcessTask(makeTask({ payloadFormat: 'evm_raw_tx' }));
      expect(mockRejectTask).toHaveBeenCalledWith(
        'task-001',
        expect.objectContaining({ reasonCode: 'signer_internal_error' })
      );
    });

    it('does NOT call claimTask() when no adapter found', async () => {
      await signer.callProcessTask(makeTask({ payloadFormat: 'evm_raw_tx' }));
      expect(mockClaimTask).not.toHaveBeenCalled();
    });
  });

  describe('claim fails (race condition)', () => {
    it('returns "skipped" when claimTask() throws (e.g. 409 race)', async () => {
      mockClaimTask.mockRejectedValueOnce(new Error('HTTP 409: already claimed'));
      const result = await signer.callProcessTask(makeTask());
      expect(result).toBe('skipped');
    });

    it('does NOT call submitTask() or rejectTask() on claim failure', async () => {
      mockClaimTask.mockRejectedValueOnce(new Error('HTTP 409'));
      await signer.callProcessTask(makeTask());
      expect(mockSubmitTask).not.toHaveBeenCalled();
      expect(mockRejectTask).not.toHaveBeenCalled();
    });
  });

  describe('signing fails', () => {
    beforeEach(() => {
      mockBtcSign.mockRejectedValueOnce(
        Object.assign(new Error('amount_limit_exceeded'), { code: 'amount_limit_exceeded' })
      );
    });

    it('returns "rejected" when adapter.sign() throws', async () => {
      const result = await signer.callProcessTask(makeTask());
      expect(result).toBe('rejected');
    });

    it('calls rejectTask() with the error code from the thrown error', async () => {
      await signer.callProcessTask(makeTask());
      expect(mockRejectTask).toHaveBeenCalledWith(
        'task-001',
        expect.objectContaining({ reasonCode: 'amount_limit_exceeded' })
      );
    });

    it('logs a signing_rejected audit event with errorCode', async () => {
      await signer.callProcessTask(makeTask());
      expect(mockAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'signing_rejected',
          taskId: 'task-001',
          errorCode: 'amount_limit_exceeded',
        })
      );
    });

    it('does NOT call submitTask() on signing failure', async () => {
      await signer.callProcessTask(makeTask());
      expect(mockSubmitTask).not.toHaveBeenCalled();
    });
  });
});

describe('OssSigner — startup() and shutdown()', () => {
  let signer: TestableSigner;

  beforeEach(() => {
    jest.clearAllMocks();
    signer = new TestableSigner();
  });

  it('startup() loads keystore', async () => {
    await signer.startup();
    expect(mockKeystoreLoad).toHaveBeenCalled();
    await signer.shutdown();
  });

  it('startup() starts the health server', async () => {
    await signer.startup();
    expect(mockHealthStart).toHaveBeenCalled();
    await signer.shutdown();
  });

  it('startup() sends initial heartbeat', async () => {
    await signer.startup();
    expect(mockHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'healthy' })
    );
    await signer.shutdown();
  });

  it('shutdown() stops the health server', async () => {
    await signer.startup();
    await signer.shutdown();
    expect(mockHealthStop).toHaveBeenCalled();
  });
});
