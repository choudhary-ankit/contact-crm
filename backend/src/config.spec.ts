import { apiKeyProblems, assertValidConfig } from './config';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const GOOD = `0123456789abcdef0123456789abcdef-fake-test-key:${ACCOUNT}`;

describe('API_KEYS validation', () => {
  it('accepts a strong key bound to an account, and several keys', () => {
    expect(apiKeyProblems(GOOD, true)).toEqual([]);
    expect(apiKeyProblems(`${GOOD}, another-long-secret-key-1234:${ACCOUNT}`, true)).toEqual([]);
  });

  it('flags the exact mistake that caused a silent 401 in production: only the account id, no key', () => {
    const problems = apiKeyProblems(ACCOUNT, true);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/entry #1 must look like "<key>:<account uuid>"/);
  });

  it.each([
    ['empty', '', /empty/],
    ['an empty key', `:${ACCOUNT}`, /must look like/],
    ['a non-uuid account', 'a-long-enough-secret-key:not-a-uuid', /account UUID/],
    ['an account id used as the key', `${ACCOUNT}:${ACCOUNT}`, /looks like an account UUID/],
  ])('rejects %s', (_label, raw, message) => {
    expect(apiKeyProblems(raw, false).join(' ')).toMatch(message);
  });

  it('in production also rejects the built-in demo keys and short keys, but allows them locally', () => {
    expect(apiKeyProblems(`demo-key:${ACCOUNT}`, true).join(' ')).toMatch(/demo key must not be used/);
    expect(apiKeyProblems(`short:${ACCOUNT}`, true).join(' ')).toMatch(/at least 16 characters/);
    expect(apiKeyProblems(`demo-key:${ACCOUNT}`, false)).toEqual([]);
  });

  it('never echoes the secret in its messages', () => {
    const secret = 'super-secret-value-that-must-not-leak';
    const text = apiKeyProblems(`${secret}:not-a-uuid`, true).join(' ') + apiKeyProblems(secret, true).join(' ');
    expect(text).not.toContain(secret);
  });

  it('assertValidConfig throws one clear error listing every problem, and passes with defaults locally', () => {
    expect(() => assertValidConfig({ NODE_ENV: 'production', API_KEYS: ACCOUNT } as NodeJS.ProcessEnv)).toThrow(/Invalid configuration/);
    expect(() => assertValidConfig({ API_KEYS: undefined } as NodeJS.ProcessEnv)).not.toThrow(); // built-in demo keys outside production
    expect(() => assertValidConfig({ NODE_ENV: 'production', API_KEYS: GOOD } as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertValidConfig({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(/demo key must not be used/); // forgot to set keys in production
  });
});
