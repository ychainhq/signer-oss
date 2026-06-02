/**
 * OssSigner — Community signer daemon.
 *
 * Extends PollingLoop from @chain-api/external-signer-core.
 * Dispatches signing tasks to the correct ISigningAdapter by payloadFormat.
 * New chain support = add a new ISigningAdapter and register it below.
 */

import {
  PollingLoop,
  PollingLoopConfig,
  SignerApiClient,
  ISigningAdapter,
} from '@chain-api/external-signer-core';
import { SigningTask } from '@chain-api/external-signer-protocol';
import { LocalKeystore } from './keystore/local-keystore';
import { BtcPsbtAdapter } from './adapters/btc-psbt-adapter';
import { EvmTxAdapter } from './adapters/evm-tx-adapter';
import { LocalAuditSink } from './audit/local-audit-sink';
import { HealthServer } from './health-server';
import {
  config,
  getSupportedChains,
  getSupportedAssets,
  getSupportedFormats,
  getFallbackUrls,
  isEvmEnabled,
} from './config';

export class OssSigner extends PollingLoop {
  private readonly keystore: LocalKeystore;
  private readonly auditSink: LocalAuditSink;
  private readonly adapters: ISigningAdapter[];
  private readonly healthServer: HealthServer;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const keystore = new LocalKeystore();
    const auditSink = new LocalAuditSink();

    const fallbackUrls = getFallbackUrls();
    const client = new SignerApiClient({
      baseUrl: config.CHAIN_API_BASE_URL,
      fallbackUrls,
      tenantId: config.TENANT_ID,
      signerId: config.SIGNER_ID,
      apiKey: config.SIGNER_API_KEY,
    });

    const loopConfig: PollingLoopConfig = {
      intervalMs: config.POLL_INTERVAL_MS,
      taskBatchSize: config.TASK_BATCH_SIZE,
      client,
      onError: (err) => process.stderr.write(`[signer] Poll error: ${err.message}\n`),
      onTaskProcessed: (task, result) =>
        process.stdout.write(`[signer] Task ${task.id} → ${result}\n`),
    };

    super(loopConfig);

    this.keystore = keystore;
    this.auditSink = auditSink;
    this.healthServer = new HealthServer(() => keystore.isHealthy());

    // Register adapters — add new chains here
    this.adapters = [
      new BtcPsbtAdapter(this.keystore),
      ...(isEvmEnabled() ? [new EvmTxAdapter(this.keystore)] : []),
    ];
  }

  async startup(): Promise<void> {
    process.stdout.write(`[signer] Starting ${config.SIGNER_NAME} (${config.SIGNER_ID})\n`);

    await this.keystore.load();
    const fingerprints = await this.keystore.listFingerprints();
    process.stdout.write(`[signer] Keys loaded: ${fingerprints.join(', ')}\n`);

    await this.healthServer.start();

    const supportedChains = getSupportedChains().join(', ');
    process.stdout.write(`[signer] Chains: ${supportedChains}\n`);

    if (config.SIGNER_AUTO_ENROLL) {
      await this.enroll();
    }

    // Initial heartbeat
    await this.sendHeartbeat().catch((err: Error) =>
      process.stderr.write(`[signer] Initial heartbeat failed: ${err.message}\n`)
    );

    // Periodic heartbeat every 30s
    this.heartbeatTimer = setInterval(async () => {
      await this.sendHeartbeat().catch((err: Error) =>
        process.stderr.write(`[signer] Heartbeat failed: ${err.message}\n`)
      );
    }, 30_000);

    this.start();
    process.stdout.write(`[signer] Polling every ${config.POLL_INTERVAL_MS}ms\n`);
  }

  async shutdown(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.stop();
    await this.healthServer.stop();
    process.stdout.write('[signer] Stopped gracefully\n');
  }

  /**
   * PollingLoop hook — called for each available task.
   * Routes to the correct adapter by payloadFormat.
   */
  protected async processTask(task: SigningTask): Promise<'signed' | 'rejected' | 'skipped'> {
    // Find the right adapter
    const adapter = this.adapters.find((a) => a.canHandle(task));
    if (!adapter) {
      process.stderr.write(
        `[signer] No adapter for task ${task.id} (format=${task.payloadFormat}, chain=${task.chain})\n`
      );
      await this.client.rejectTask(task.id, {
        reasonCode: 'signer_internal_error',
        reasonMessage: `Unsupported payload format '${task.payloadFormat}' for chain '${task.chain}'`,
        rejectedAt: new Date().toISOString(),
      }).catch(() => {});
      return 'rejected';
    }

    // Claim
    let claimed: SigningTask;
    try {
      claimed = await this.client.claimTask(task.id);
    } catch (err) {
      process.stderr.write(`[signer] Failed to claim task ${task.id}: ${String(err)}\n`);
      return 'skipped';
    }

    // Sign
    try {
      const signResult = await adapter.sign(claimed);

      await this.client.submitTask(task.id, {
        signedPayload: signResult.signedPayload,
        signedPayloadHash: signResult.signedPayloadHash,
        signerFingerprint: signResult.signerFingerprint,
        signerResponseSignature: signResult.signerResponseSignature,
        signedAt: signResult.signedAt,
      });

      await this.auditSink.log({
        id: `audit_${Date.now()}`,
        type: 'signing_signed',
        taskId: task.id,
        signerId: config.SIGNER_ID,
        result: 'signed',
        chainId: claimed.chain,
        assetId: claimed.assetId,
        amountRaw: claimed.amountRaw,
        timestamp: new Date().toISOString(),
      });

      return 'signed';
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const code = (err as { code?: string }).code ?? 'signing_failed';

      process.stderr.write(`[signer] Signing failed for task ${task.id}: ${message}\n`);

      await this.client.rejectTask(task.id, {
        reasonCode: code,
        reasonMessage: message,
        rejectedAt: new Date().toISOString(),
      }).catch(() => {});

      await this.auditSink.log({
        id: `audit_${Date.now()}`,
        type: 'signing_rejected',
        taskId: task.id,
        signerId: config.SIGNER_ID,
        result: 'rejected',
        chainId: claimed.chain,
        assetId: claimed.assetId,
        amountRaw: claimed.amountRaw,
        errorCode: code,
        errorMessage: message,
        timestamp: new Date().toISOString(),
      });

      return 'rejected';
    }
  }

  private async enroll(): Promise<void> {
    try {
      await this.client.heartbeat({
        status: 'healthy',
        version: '1.0.0',
        capabilities: {
          chains: getSupportedChains(),
          assets: getSupportedAssets(),
          formats: getSupportedFormats(),
        },
        keyFingerprints: await this.keystore.listFingerprints(),
        time: new Date().toISOString(),
      });
      process.stdout.write('[signer] Auto-enrolled with chain-api\n');
    } catch (err) {
      process.stderr.write(`[signer] Auto-enroll warning: ${String(err)}\n`);
    }
  }

  private async sendHeartbeat(): Promise<void> {
    await this.client.heartbeat({
      status: (await this.keystore.isHealthy()) ? 'healthy' : 'unhealthy',
      version: '1.0.0',
      capabilities: {
        chains: getSupportedChains(),
        assets: getSupportedAssets(),
        formats: getSupportedFormats(),
      },
      keyFingerprints: await this.keystore.listFingerprints(),
      time: new Date().toISOString(),
    });
  }
}
