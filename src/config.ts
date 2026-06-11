import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  SIGNER_MODE: z.enum(['community', 'enterprise']).default('community'),
  SIGNER_ID: z.string().min(1),
  SIGNER_NAME: z.string().default('chain-api OSS Signer'),
  TENANT_ID: z.string().min(1),

  CHAIN_API_BASE_URL: z.string().url(),
  // Optional: comma-separated fallback engine URLs for active-active clusters.
  // Example: CHAIN_API_FALLBACK_URLS=http://engine-2:3001,http://engine-3:3002
  CHAIN_API_FALLBACK_URLS: z.string().default(''),
  SIGNER_API_KEY: z.string().min(1),

  POLL_INTERVAL_MS: z.coerce.number().int().min(1000).default(5000),
  TASK_BATCH_SIZE: z.coerce.number().int().min(1).max(20).default(5),

  SUPPORTED_CHAINS: z.string().default('bitcoin'),
  SUPPORTED_ASSETS: z.string().default('bitcoin:BTC'),
  SUPPORTED_FORMATS: z.string().default('btc_psbt'),

  // --- BTC signing ---
  BTC_SIGNING_MODE: z.enum(['dev_env_key', 'keystore_file']).default('dev_env_key'),
  BTC_DEV_PRIVATE_KEY_WIF: z.string().optional(),
  // BTC_DEV_ACCOUNT_XPRV: account-level xprv (m/44'/0'/0') for HD sweep signing.
  // Required when signing btc_sweep tasks. Dev ONLY — never use with real funds.
  BTC_DEV_ACCOUNT_XPRV: z.string().optional(),
  // SIGNER_FINGERPRINT_HD: fingerprint identifying the HD account xprv entry.
  // Defaults to SIGNER_FINGERPRINT if not set.
  SIGNER_FINGERPRINT_HD: z.string().optional(),
  BTC_KEYSTORE_PATH: z.string().optional(),
  BTC_KEYSTORE_PASSWORD: z.string().optional(),
  BTC_NETWORK: z.enum(['mainnet', 'testnet', 'regtest']).default('regtest'),

  // --- EVM signing (optional — enable by adding ethereum to SUPPORTED_CHAINS) ---
  // EVM_DEV_PRIVATE_KEY_HEX: raw 32-byte private key as 64-char hex. Dev ONLY.
  EVM_DEV_PRIVATE_KEY_HEX: z.string().optional(),
  // EVM_SIGNER_FINGERPRINT: stable identifier for the EVM key (e.g. "evm:addr:0xABCD...")
  EVM_SIGNER_FINGERPRINT: z.string().optional(),
  // EVM_CHAIN_IDS: comma-separated chain IDs this signer accepts (e.g. "1,137,8453")
  EVM_CHAIN_IDS: z.string().optional(),

  // --- TRON signing (optional — enable by adding tron to SUPPORTED_CHAINS) ---
  // TRON_DEV_PRIVATE_KEY_HEX: raw 32-byte private key as 64-char hex. Dev ONLY.
  TRON_DEV_PRIVATE_KEY_HEX: z.string().optional(),
  TRON_SIGNER_FINGERPRINT: z.string().optional(),
  TRON_NETWORK: z.string().default('private'),
  TRON_ALLOWED_CONTRACTS: z.string().default(''),
  MAX_AUTO_SIGN_AMOUNT_SUN: z.coerce.bigint().default(1_000_000_000n),
  MAX_TRON_FEE_LIMIT_SUN: z.coerce.bigint().default(50_000_000n),

  // --- Community policy ---
  MAX_AUTO_SIGN_AMOUNT_SATS: z.coerce.bigint().default(1_000_000n),
  MAX_FEE_RATE_SAT_VB: z.coerce.number().int().default(50),
  MAX_OUTPUTS_PER_BATCH: z.coerce.number().int().default(200),
  ALLOWED_DESTINATIONS: z.string().default(''),

  // --- Audit ---
  AUDIT_LOG_FILE: z.string().default('./data/audit.log'),
  AUDIT_STDOUT: z.coerce.boolean().default(true),

  // --- HTTP status server ---
  SIGNER_PORT: z.coerce.number().int().default(3101),
  SIGNER_BIND_HOST: z.string().default('127.0.0.1'),

  // --- Enrollment ---
  SIGNER_AUTO_ENROLL: z.coerce.boolean().default(true),
  SIGNER_FINGERPRINT: z.string().default('btc:placeholder:0000000000000000'),
  SIGNER_PUBLIC_KEY: z.string().default('ed25519:placeholder'),
});

function parseConfig() {
  const result = configSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid signer configuration:');
    result.error.issues.forEach((issue) => {
      console.error(`  ${issue.path.join('.')}: ${issue.message}`);
    });
    process.exit(1);
  }
  return result.data;
}

export const config = parseConfig();

export function getSupportedChains(): string[] {
  return config.SUPPORTED_CHAINS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getSupportedAssets(): string[] {
  return config.SUPPORTED_ASSETS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getSupportedFormats(): string[] {
  return config.SUPPORTED_FORMATS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getAllowedDestinations(): string[] {
  if (!config.ALLOWED_DESTINATIONS) return [];
  return config.ALLOWED_DESTINATIONS.split(',').map((s) => s.trim()).filter(Boolean);
}

export function getEvmChainIds(): number[] {
  if (!config.EVM_CHAIN_IDS) return [];
  return config.EVM_CHAIN_IDS.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
}

export function isEvmEnabled(): boolean {
  return getSupportedChains().some((c) => c !== 'bitcoin' && c !== 'tron');
}

export function isTronEnabled(): boolean {
  return getSupportedChains().includes('tron');
}

export function getTronAllowedContracts(): string[] {
  if (!config.TRON_ALLOWED_CONTRACTS) return [];
  return config.TRON_ALLOWED_CONTRACTS.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Returns fallback engine URLs for active-active cluster mode. */
export function getFallbackUrls(): string[] {
  if (!config.CHAIN_API_FALLBACK_URLS) return [];
  return config.CHAIN_API_FALLBACK_URLS.split(',').map((s) => s.trim()).filter(Boolean);
}
