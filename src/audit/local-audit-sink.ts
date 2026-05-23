import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface AuditEvent {
  id: string;
  type: string;
  taskId?: string;
  signerId: string;
  result: string;
  chainId?: string;
  assetId?: string;
  amountRaw?: string;
  txHash?: string;
  errorCode?: string;
  errorMessage?: string;
  timestamp: string;
  [key: string]: unknown;
}

export class LocalAuditSink {
  private logFilePath: string | null;

  constructor() {
    this.logFilePath = config.AUDIT_LOG_FILE || null;

    if (this.logFilePath) {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  async log(event: AuditEvent): Promise<void> {
    const line = JSON.stringify({ ...event, _audit: true }) + '\n';

    if (config.AUDIT_STDOUT) {
      process.stdout.write(line);
    }

    if (this.logFilePath) {
      try {
        fs.appendFileSync(this.logFilePath, line, 'utf-8');
      } catch (err) {
        process.stderr.write(`[audit-sink] Failed to write audit log: ${String(err)}\n`);
      }
    }
  }
}
