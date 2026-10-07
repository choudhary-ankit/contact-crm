import { decodeCursor, encodeCursor } from './cursor';

const id = '11111111-1111-4111-8111-111111111111';

describe('cursor', () => {
  it('round-trips', () => {
    const c = encodeCursor({ s: 'name:asc', v: 'lovelace ada', id });
    expect(decodeCursor(c, 'name:asc')).toEqual({ s: 'name:asc', v: 'lovelace ada', id });
  });

  it('rejects a cursor produced for a different ordering', () => {
    const c = encodeCursor({ s: 'name:asc', v: 'x', id });
    expect(() => decodeCursor(c, 'createdAt:desc')).toThrow(/does not match/);
  });

  it.each(['not-base64-json', Buffer.from('{"s":1}').toString('base64url'), ''])('rejects garbage %j', (bad) => {
    expect(() => decodeCursor(bad, 'name:asc')).toThrow();
  });

  it('rejects a non-uuid id (guards the ::uuid cast)', () => {
    const c = encodeCursor({ s: 'name:asc', v: 'x', id: "1' OR '1'='1" });
    expect(() => decodeCursor(c, 'name:asc')).toThrow();
  });
});
