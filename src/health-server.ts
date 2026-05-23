import { HealthServer as CoreHealthServer } from '@chain-api/external-signer-core';
import { config } from './config';

/**
 * OSS signer health server — thin wrapper over the shared HealthServer from
 * external-signer-core that binds OSS config values at construction time.
 */
export class HealthServer {
  private readonly server: CoreHealthServer;

  constructor(healthFn: () => Promise<boolean>) {
    this.server = new CoreHealthServer({
      port: config.SIGNER_PORT,
      host: config.SIGNER_BIND_HOST,
      signerId: config.SIGNER_ID,
      healthFn,
    });
  }

  start(): Promise<void> { return this.server.start(); }
  stop(): Promise<void>  { return this.server.stop(); }
}
