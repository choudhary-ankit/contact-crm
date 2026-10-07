import { ApiError } from '../common/api-error';

/** Opaque keyset cursor: the sort key of the last row seen + its id as a tiebreaker. */
export interface CursorPayload {
  /** `${sort}:${order}` - a cursor is only valid for the ordering that produced it */
  s: string;
  /** last row's sort value, as text so microsecond timestamps survive */
  v: string;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(cursor: string, expectedOrdering: string): CursorPayload {
  const invalid = () => new ApiError(400, 'INVALID_CURSOR', 'Cursor is invalid or does not match the requested sort');
  try {
    const p = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof p?.s !== 'string' || typeof p?.v !== 'string' || typeof p?.id !== 'string') throw invalid();
    if (p.s !== expectedOrdering || !UUID.test(p.id)) throw invalid();
    return p;
  } catch (e) {
    throw e instanceof ApiError ? e : invalid();
  }
}
