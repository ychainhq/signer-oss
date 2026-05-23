import http from 'http';
import { config } from './config';

export class HealthServer {
  private server: http.Server;
  private isReady = false;
  private healthFn: () => Promise<boolean>;

  constructor(healthFn: () => Promise<boolean>) {
    this.healthFn = healthFn;
    this.server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        void this.respondHealth(res);
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });
  }

  private async respondHealth(res: http.ServerResponse): Promise<void> {
    try {
      const healthy = this.isReady && await this.healthFn();
      const body = JSON.stringify({
        status: healthy ? 'ok' : 'degraded',
        signerId: config.SIGNER_ID,
        healthy,
        uptime: Math.floor(process.uptime()),
      });
      res.writeHead(healthy ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(body);
    } catch {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', signerId: config.SIGNER_ID, healthy: false, uptime: 0 }));
    }
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(config.SIGNER_PORT, config.SIGNER_BIND_HOST, () => {
        this.isReady = true;
        process.stdout.write(`[health] HTTP server on ${config.SIGNER_BIND_HOST}:${config.SIGNER_PORT}/health\n`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    this.isReady = false;
    return new Promise((resolve) => this.server.close(() => resolve()));
  }
}
