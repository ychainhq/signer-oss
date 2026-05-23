/**
 * OssSigner — main signer class.
 *
 * Manages the polling loop, task processing, heartbeat, and auto-enrollment.
 */

import { LocalKeystore } from './keystore/local-keystore';
import { BtcPsbtAdapter } from './adapters/btc-psbt-adapter';
import { LocalAuditSink } from './audit/local-audit-sink';
import { config, getSupportedChains, getSupportedAssets, getSupportedFormats } from './config';

// Inline API client (avoids dependency on shared package for OSS self-containment)
class SimpleApiClient {
  private baseUrl: string;
  private apiKey: string;
  private signerId: string;

  constructor() {
    this.baseUrl = config.CHAIN_API_BASE_URL;
    this.apiKey = config.SIGNER_API_KEY;
    this.signerId = config.SIGNER_ID;
  }

  private get headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async enroll(): Promise<void> {
    await this.request('POST', '/v1/external-signers/enroll', {
      name: config.SIGNER_NAME,
      edition: 'community',
      publicKey: config.SIGNER_PUBLIC_KEY,
      signerFingerprint: config.SIGNER_FINGERPRINT,
      capabilities: {
        chains: getSupportedChains(),
        assets: getSupportedAssets(),
        formats: getSupportedFormats(),
      },
    });
  }

  async heartbeat(): Promise<void> {
    await this.request('POST', `/v1/external-signers/${this.signerId}/heartbeat`, {
      status: 'healthy',
      version: '1.0.0',
      capabilities: {
        chains: getSupportedChains(),
        assets: getSupportedAssets(),
        formats: getSupportedFormats(),
      },
      keyFingerprints: [config.SIGNER_FINGERPRINT],
      time: new Date().toISOString(),
    });
  }

  async listTasks(limit = 5): Promise<any[]> {
    const result = await this.request<{ items: any[] }>(
      'GET', `/v1/external-signers/${this.signerId}/tasks?limit=${limit}`
    );
    return result.items ?? [];
  }

  async claimTask(taskId: string): Promise<any> {
    const result = await this.request<{ data: any }>(
      'POST', `/v1/external-signers/${this.signerId}/tasks/${taskId}/claim`, {}
    );
    return result.data;
  }

  async submitTask(taskId: string, body: object): Promise<any> {
    const result = await this.request<{ data: any }>(
      'POST', `/v1/external-signers/${this.signerId}/tasks/${taskId}/submit`, body
    );
    return result.data;
  }

  async rejectTask(taskId: string, body: object): Promise<any> {
    const result = await this.request<{ data: any }>(
      'POST', `/v1/external-signers/${this.signerId}/tasks/${taskId}/reject`, body
    );
    return result.data;
  }
}

export class OssSigner {
  private keystore: LocalKeystore;
  private btcAdapter: BtcPsbtAdapter;
  private auditSink: LocalAuditSink;
  private client: SimpleApiClient;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private processingTask = false;

  constructor() {
    this.keystore = new LocalKeystore();
    this.btcAdapter = new BtcPsbtAdapter(this.keystore);
    this.auditSink = new LocalAuditSink();
    this.client = new SimpleApiClient();
  }

  async start(): Promise<void> {
    process.stdout.write(`[signer] Starting ${config.SIGNER_NAME} (${config.SIGNER_ID})...\n`);

    // Load keys
    await this.keystore.load();
    process.stdout.write(`[signer] Keystore loaded. Fingerprints: ${this.keystore.listFingerprints().join(', ')}\n`);

    // Auto-enroll
    if (config.SIGNER_AUTO_ENROLL) {
      try {
        await this.client.enroll();
        process.stdout.write(`[signer] Auto-enrolled with chain-api\n`);
      } catch (err) {
        process.stderr.write(`[signer] Auto-enroll warning: ${String(err)}\n`);
      }
    }

    this.running = true;

    // Start heartbeat (every 30s)
    this.heartbeatInterval = setInterval(async () => {
      try {
        await this.client.heartbeat();
      } catch (err) {
        process.stderr.write(`[signer] Heartbeat failed: ${String(err)}\n`);
      }
    }, 30_000);

    // Send initial heartbeat
    try {
      await this.client.heartbeat();
      process.stdout.write(`[signer] Initial heartbeat sent\n`);
    } catch (err) {
      process.stderr.write(`[signer] Initial heartbeat failed: ${String(err)}\n`);
    }

    // Start polling loop
    this.pollInterval = setInterval(async () => {
      if (this.processingTask) return;
      this.processingTask = true;
      try {
        await this.pollAndProcess();
      } catch (err) {
        process.stderr.write(`[signer] Poll error: ${String(err)}\n`);
      } finally {
        this.processingTask = false;
      }
    }, config.POLL_INTERVAL_MS);

    process.stdout.write(`[signer] Polling every ${config.POLL_INTERVAL_MS}ms\n`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollInterval) { clearInterval(this.pollInterval); this.pollInterval = null; }
    if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
    process.stdout.write(`[signer] Stopped gracefully\n`);
  }

  private async pollAndProcess(): Promise<void> {
    let tasks: any[];
    try {
      tasks = await this.client.listTasks(config.TASK_BATCH_SIZE);
    } catch (err) {
      process.stderr.write(`[signer] Failed to list tasks: ${String(err)}\n`);
      return;
    }

    if (tasks.length === 0) return;

    for (const task of tasks) {
      await this.processTask(task);
    }
  }

  private async processTask(task: any): Promise<void> {
    const taskId = task.id;

    // Claim the task
    let claimed: any;
    try {
      claimed = await this.client.claimTask(taskId);
    } catch (err) {
      process.stderr.write(`[signer] Failed to claim task ${taskId}: ${String(err)}\n`);
      return;
    }

    // Only handle BTC PSBT for now
    if (claimed.payloadFormat !== 'btc_psbt') {
      process.stderr.write(`[signer] Unsupported payload format: ${claimed.payloadFormat}\n`);
      await this.client.rejectTask(taskId, {
        reasonCode: 'signer_internal_error',
        reasonMessage: `Unsupported payload format: ${claimed.payloadFormat}`,
        rejectedAt: new Date().toISOString(),
      });
      return;
    }

    // Sign
    let signResult: any;
    try {
      signResult = await this.btcAdapter.sign({
        taskId,
        unsignedPayload: claimed.unsignedPayload,
        unsignedPayloadHash: claimed.unsignedPayloadHash,
        amountRaw: claimed.amountRaw,
        feeRateSatVb: claimed.feeRateSatVb,
        outputsCount: claimed.outputsCount,
        expiresAt: claimed.expiresAt,
      });
    } catch (err: any) {
      process.stderr.write(`[signer] Signing failed for task ${taskId}: ${String(err)}\n`);

      await this.client.rejectTask(taskId, {
        reasonCode: err.code ?? 'signing_failed',
        reasonMessage: String(err.message ?? err),
        rejectedAt: new Date().toISOString(),
      }).catch(() => {});

      await this.auditSink.log({
        id: `audit_${Date.now()}`,
        type: 'signing_rejected',
        taskId,
        signerId: config.SIGNER_ID,
        result: 'rejected',
        chainId: 'bitcoin',
        assetId: 'bitcoin:BTC',
        amountRaw: claimed.amountRaw,
        errorCode: err.code,
        errorMessage: String(err.message ?? err),
        timestamp: new Date().toISOString(),
      });

      return;
    }

    // Submit signed payload
    try {
      await this.client.submitTask(taskId, {
        signedPayload: signResult.signedPayload,
        signedPayloadHash: signResult.signedPayloadHash,
        signerFingerprint: signResult.signerFingerprint,
        signedAt: signResult.signedAt,
      });

      process.stdout.write(`[signer] Task ${taskId} signed and submitted\n`);

      await this.auditSink.log({
        id: `audit_${Date.now()}`,
        type: 'signing_signed',
        taskId,
        signerId: config.SIGNER_ID,
        result: 'signed',
        chainId: 'bitcoin',
        assetId: 'bitcoin:BTC',
        amountRaw: claimed.amountRaw,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      process.stderr.write(`[signer] Submit failed for task ${taskId}: ${String(err)}\n`);
    }
  }
}
