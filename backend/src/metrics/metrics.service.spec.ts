import { MetricsService } from './metrics.service';

type Svc = { compute: (a: string, r: number) => Promise<unknown> };

const make = (compute: () => Promise<unknown>) => {
  const svc = new MetricsService({} as never);
  jest.spyOn(svc as unknown as Svc, 'compute').mockImplementation(compute as never);
  return svc;
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('MetricsService load protection', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  it('shares one computation between concurrent requests (single flight)', async () => {
    process.env.METRICS_CACHE_TTL_MS = '30000';
    let calls = 0;
    const svc = make(async () => {
      calls++;
      await delay(30);
      return { n: calls };
    });
    const results = await Promise.all(Array.from({ length: 50 }, () => svc.get('a', 30)));
    expect(calls).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
  });

  it('serves the old numbers immediately while one refresh runs, once the cache has expired', async () => {
    process.env.METRICS_CACHE_TTL_MS = '10';
    let calls = 0;
    const svc = make(async () => {
      calls++;
      await delay(40);
      return { n: calls };
    });
    expect(await svc.get('a', 30)).toEqual({ n: 1 });
    await delay(20);
    const started = Date.now();
    const stale = await Promise.all([svc.get('a', 30), svc.get('a', 30), svc.get('a', 30)]);
    expect(Date.now() - started).toBeLessThan(30); // did not wait for the refresh
    expect(stale.every((s) => (s as { n: number }).n === 1)).toBe(true);
    expect(calls).toBe(2); // exactly one refresh
    await delay(60);
    expect(await svc.get('a', 30)).toEqual({ n: 2 });
  });

  it('never serves numbers older than the maximum staleness', async () => {
    process.env.METRICS_CACHE_TTL_MS = '5';
    process.env.METRICS_MAX_STALE_MS = '20';
    let calls = 0;
    const svc = make(async () => ({ n: ++calls }));
    await svc.get('a', 30);
    await delay(40);
    expect(await svc.get('a', 30)).toEqual({ n: 2 }); // waited for fresh numbers
  });

  it('limits how many different computations run at once', async () => {
    process.env.METRICS_CACHE_TTL_MS = '30000';
    process.env.METRICS_MAX_CONCURRENT = '2';
    let active = 0;
    let peak = 0;
    const svc = make(async () => {
      peak = Math.max(peak, ++active);
      await delay(20);
      active--;
      return {};
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => svc.get(`acct-${i}`, 30)));
    expect(peak).toBe(2);
  });

  it('a failed computation is not cached and the next request retries', async () => {
    process.env.METRICS_CACHE_TTL_MS = '30000';
    let calls = 0;
    const svc = make(async () => {
      if (++calls === 1) throw new Error('boom');
      return { ok: true };
    });
    await expect(svc.get('a', 30)).rejects.toThrow('boom');
    expect(await svc.get('a', 30)).toEqual({ ok: true });
  });
});
