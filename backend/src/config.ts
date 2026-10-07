import 'dotenv/config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEAK_DEFAULT_KEYS = new Set(['demo-key', 'demo-key-2']);

/**
 * Checks API_KEYS and returns human-readable problems. It never echoes the keys themselves (they are secrets).
 * `production` adds stricter rules: no built-in demo keys and a minimum key length.
 */
export function apiKeyProblems(raw: string, production: boolean): string[] {
  const problems: string[] = [];
  const entries = raw.split(',').map((e) => e.trim()).filter(Boolean);
  if (!entries.length) return ['API_KEYS is empty. Expected "<key>:<account uuid>" (comma-separate several)'];
  entries.forEach((entry, i) => {
    const n = i + 1;
    const idx = entry.indexOf(':');
    if (idx <= 0) {
      problems.push(`API_KEYS entry #${n} must look like "<key>:<account uuid>" (the ":" and an account id are missing or the key is empty)`);
      return;
    }
    const key = entry.slice(0, idx).trim();
    const account = entry.slice(idx + 1).trim();
    if (!UUID.test(account)) problems.push(`API_KEYS entry #${n}: the part after ":" must be an account UUID`);
    if (UUID.test(key)) problems.push(`API_KEYS entry #${n}: the key looks like an account UUID; put the secret key before the ":"`);
    if (production && WEAK_DEFAULT_KEYS.has(key)) problems.push(`API_KEYS entry #${n}: the built-in demo key must not be used in production`);
    if (production && key.length < 16) problems.push(`API_KEYS entry #${n}: the key must be at least 16 characters in production`);
  });
  return problems;
}

/** Called once at startup: refuse to boot with a configuration that would silently reject every request. */
export function assertValidConfig(env: NodeJS.ProcessEnv = process.env): void {
  const problems = apiKeyProblems(env.API_KEYS ?? DEFAULT_KEYS, env.NODE_ENV === 'production');
  if (problems.length) throw new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
}

export interface AppConfig {
  port: number;
  databaseUrl: string;
  /** api key -> account id */
  apiKeys: Map<string, string>;
  rateLimitPerMin: number;
  writeRateLimitPerMin: number;
  corsOrigin: string;
  autoMigrate: boolean;
  importWorkerEnabled: boolean;
  importMaxRows: number;
  importMaxBytes: number;
  importChunkSize: number;
  metricsCacheTtlMs: number;
  /** number of reverse proxies in front of the app (Render = 1), so rate limiting sees each visitor's real IP */
  trustProxy: number;
}

const DEFAULT_KEYS =
  'demo-key:11111111-1111-4111-8111-111111111111,demo-key-2:22222222-2222-4222-8222-222222222222';

/** Read at call time (not import time) so tests can override process.env per suite. */
export function loadConfig(): AppConfig {
  const apiKeys = new Map<string, string>();
  for (const pair of (process.env.API_KEYS ?? DEFAULT_KEYS).split(',')) {
    const idx = pair.indexOf(':');
    if (idx > 0) apiKeys.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: process.env.DATABASE_URL ?? 'postgres://crm:crm@localhost:5432/crm',
    apiKeys,
    rateLimitPerMin: Number(process.env.RATE_LIMIT_PER_MIN ?? 300),
    writeRateLimitPerMin: Number(process.env.WRITE_RATE_LIMIT_PER_MIN ?? 60),
    corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
    autoMigrate: (process.env.AUTO_MIGRATE ?? 'true') === 'true',
    importWorkerEnabled: (process.env.IMPORT_WORKER_ENABLED ?? 'true') === 'true',
    importMaxRows: Number(process.env.IMPORT_MAX_ROWS ?? 50_000),
    importMaxBytes: Number(process.env.IMPORT_MAX_BYTES ?? 5 * 1024 * 1024),
    importChunkSize: Number(process.env.IMPORT_CHUNK_SIZE ?? 500),
    metricsCacheTtlMs: Number(process.env.METRICS_CACHE_TTL_MS ?? 30_000),
    trustProxy: Number(process.env.TRUST_PROXY ?? 0),
  };
}
