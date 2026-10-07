import 'dotenv/config';

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
