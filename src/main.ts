/**
 * chain-api Community Signer — Entry Point
 *
 * Handles graceful shutdown on SIGTERM/SIGINT.
 */

import 'dotenv/config';
import { OssSigner } from './signer';

const signer = new OssSigner();

async function main(): Promise<void> {
  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    process.stdout.write(`\n[main] Received ${signal}, shutting down...\n`);
    await signer.stop();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await signer.start();
    process.stdout.write('[main] Signer running. Press Ctrl+C to stop.\n');
  } catch (err) {
    process.stderr.write(`[main] Fatal error: ${String(err)}\n`);
    process.exit(1);
  }
}

void main();
