import 'dotenv/config';
import { OssSigner } from './signer';

const signer = new OssSigner();

async function main(): Promise<void> {
  const shutdown = async (signal: string) => {
    process.stdout.write(`\n[main] ${signal} received, shutting down...\n`);
    await signer.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  try {
    await signer.startup();
    process.stdout.write('[main] Signer running. Press Ctrl+C to stop.\n');
  } catch (err) {
    process.stderr.write(`[main] Fatal error: ${String(err)}\n`);
    process.exit(1);
  }
}

void main();
