import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { api, createApp, KEY_A } from './helpers';

describe('rate limiting', () => {
  let app: INestApplication;
  const saved = process.env.RATE_LIMIT_PER_MIN;

  beforeAll(async () => {
    process.env.RATE_LIMIT_PER_MIN = '3'; // read when the app is created
    ({ app } = await createApp());
  });
  afterAll(async () => {
    process.env.RATE_LIMIT_PER_MIN = saved;
    await app.close();
  });

  it('returns 429 with the standard error body after the limit is exceeded', async () => {
    const http = api(app);
    for (let i = 0; i < 3; i++) await http.get('/tags').expect(200);
    const res = await http.get('/tags').expect(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('rate limiting behind a proxy', () => {
  const restore = { limit: process.env.RATE_LIMIT_PER_MIN, trust: process.env.TRUST_PROXY };
  afterEach(() => {
    process.env.RATE_LIMIT_PER_MIN = restore.limit;
    if (restore.trust === undefined) delete process.env.TRUST_PROXY;
    else process.env.TRUST_PROXY = restore.trust;
  });

  const hit = (app: INestApplication, ip: string) =>
    request(app.getHttpServer()).get('/tags').set('Authorization', `Bearer ${KEY_A}`).set('X-Forwarded-For', ip);

  it('with TRUST_PROXY=1 each visitor (X-Forwarded-For) gets their own limit', async () => {
    process.env.RATE_LIMIT_PER_MIN = '2';
    process.env.TRUST_PROXY = '1';
    const { app } = await createApp();
    try {
      await hit(app, '1.1.1.1').expect(200);
      await hit(app, '1.1.1.1').expect(200);
      await hit(app, '1.1.1.1').expect(429); // visitor 1 is limited...
      await hit(app, '2.2.2.2').expect(200); // ...visitor 2 is not
    } finally {
      await app.close();
    }
  });

  it('without it, a spoofed X-Forwarded-For header cannot dodge the limit', async () => {
    process.env.RATE_LIMIT_PER_MIN = '2';
    delete process.env.TRUST_PROXY;
    const { app } = await createApp();
    try {
      await hit(app, '1.1.1.1').expect(200);
      await hit(app, '2.2.2.2').expect(200);
      await hit(app, '3.3.3.3').expect(429); // same real client, so the same bucket
    } finally {
      await app.close();
    }
  });
});
