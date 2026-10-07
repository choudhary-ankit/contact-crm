import { csvSafe, CsvFormatError, mapColumns, normalizeHeader, parseCsv, toCsvLine } from './csv';
import { FORMATS } from './formats';
import { readRow } from './row-validation';

const parse = (s: string, max = 100) => parseCsv(Buffer.from(s), max);

describe('parseCsv', () => {
  it('parses quoted commas, escaped quotes and newlines inside quotes', () => {
    const { header, rows } = parse('a,b\n"Acme, Inc.","say ""hi"""\n"line1\nline2",x\n');
    expect(header).toEqual(['a', 'b']);
    expect(rows).toEqual([['Acme, Inc.', 'say "hi"'], ['line1\nline2', 'x']]);
  });

  it('handles CRLF, a UTF-8 BOM and blank lines', () => {
    const { header, rows } = parseCsv(Buffer.from('﻿first_name,last_name\r\nAda,Lovelace\r\n\r\nGrace,Hopper\r\n'), 10);
    expect(header).toEqual(['first_name', 'last_name']);
    expect(rows).toHaveLength(2);
  });

  it('tolerates rows with fewer or more cells than the header', () => {
    expect(parse('a,b,c\n1\n1,2,3,4\n').rows).toEqual([['1'], ['1', '2', '3', '4']]);
  });

  it('rejects empty files, unterminated quotes and too many rows', () => {
    expect(() => parse('')).toThrow(CsvFormatError);
    expect(() => parse('a,b\n"oops,1\n')).toThrow(/not valid CSV/);
    expect(() => parse('a\n1\n2\n3\n', 2)).toThrow(/limit is 2/);
  });
});

describe('mapColumns', () => {
  it('accepts aliases, any case and spaces', () => {
    const { index } = mapColumns(['First Name', 'LASTNAME', 'E-mail', 'Phone Number', 'Company Name', 'Tag'], 'create');
    expect(index).toEqual({ first_name: 0, last_name: 1, email: 2, phone: 3, company: 4, tags: 5 });
  });

  it('reports unknown columns as ignored', () => {
    expect(mapColumns(['first_name', 'last_name', 'favourite colour'], 'create').ignored).toEqual(['favourite colour']);
  });

  it.each([
    ['create', ['first_name'], /Missing required column: last_name/],
    ['update', ['first_name', 'phone'], /Missing required column: email/],
    ['update', ['email'], /at least one column to change/],
    ['create', ['first_name', 'last_name', 'firstname'], /appears twice/],
  ] as const)('%s mode rejects %j', (mode, header, message) => {
    expect(() => mapColumns([...header], mode)).toThrow(message);
  });

  it('normalizes headers', () => {
    expect(normalizeHeader(' ﻿First-Name ')).toBe('first_name');
  });
});

describe('csvSafe / toCsvLine', () => {
  it.each(['=1+1', '@SUM(A1)', '-2+3', '+cmd|x', '\tx', '-cmd'])('neutralises formula-like cell %j', (cell) => {
    expect(csvSafe(cell)).toBe(`'${cell}`);
  });

  it.each(['+1 (415) 555-0172', '-', 'Ada', '(212) 555-0199', '555-0100', ''])('leaves %j alone', (cell) => {
    expect(csvSafe(cell)).toBe(cell);
  });

  it('quotes cells that need it and ends lines with CRLF', () => {
    expect(toCsvLine(['a,b', 'say "hi"', 'x\ny', 'plain'])).toBe('"a,b","say ""hi""","x\ny",plain\r\n');
  });

  it('round-trips through the parser', () => {
    const cells = ['Acme, Inc.', 'say "hi"', 'two\nlines', '+1 415 555 0172'];
    expect(parse('h1,h2,h3,h4\n' + toCsvLine(cells)).rows[0]).toEqual(cells);
  });
});

describe('readRow - create mode', () => {
  const map = mapColumns(['first_name', 'last_name', 'email', 'phone', 'company', 'tags'], 'create');
  const read = (...cells: string[]) => readRow('create', cells, map);

  it('normalises a good row', () => {
    const { values, errors } = read(' Ada ', 'Lovelace', ' ADA@X.IO ', '+1 415 555 0172', 'Acme', 'VIP; vip ;Lead');
    expect(errors).toEqual([]);
    expect(values).toMatchObject({ firstName: 'Ada', lastName: 'Lovelace', email: 'ada@x.io', phone: '+1 415 555 0172', company: 'Acme' });
    expect(values.tags).toEqual(['VIP', 'Lead']); // trimmed, case-insensitive de-dupe
  });

  it('turns blank optional cells into null', () => {
    expect(read('A', 'B', '', '', '', '').values).toMatchObject({ email: null, phone: null, company: null, tags: [] });
  });

  it('reports every problem with a friendly message', () => {
    const { errors } = read('', 'B'.repeat(101), 'nope', '12', 'C'.repeat(151), 'x'.repeat(51));
    expect(errors.map((e) => e.field).sort()).toEqual(['company', 'email', 'first_name', 'last_name', 'phone', 'tags']);
    expect(errors.find((e) => e.field === 'first_name')!.message).toBe('First name is required');
    expect(errors.find((e) => e.field === 'email')!.message).toBe('Not a valid email address');
  });

  it('limits tags per row', () => {
    const tags = Array.from({ length: 21 }, (_, i) => `t${i}`).join(';');
    expect(read('A', 'B', '', '', '', tags).errors[0].message).toMatch(/at most 20 tags/);
  });
});

describe('readRow - update mode', () => {
  const map = mapColumns(['email', 'first_name', 'phone', 'company', 'tags'], 'update');
  const read = (...cells: string[]) => readRow('update', cells, map);

  it('blank cells leave fields unchanged (undefined), [clear] empties optional fields (null)', () => {
    const { values, errors } = read('ada@x.io', '', '[CLEAR]', 'New Co', '');
    expect(errors).toEqual([]);
    expect(values.firstName).toBeUndefined();
    expect(values.phone).toBeNull();
    expect(values.company).toBe('New Co');
    expect(values.email).toBe('ada@x.io');
  });

  it('requires the email key and refuses to clear names or tags', () => {
    expect(read('', 'A', '', '', '').errors.map((e) => e.message)).toContain('Email is required to find the contact');
    expect(read('a@x.io', '[clear]', '', '', '').errors[0].message).toBe("First name can't be cleared");
    expect(read('a@x.io', '', '', '', '[clear]').errors[0].message).toMatch(/only adds tags/);
  });

  it('does not touch columns that are not in the file', () => {
    const small = mapColumns(['email', 'company'], 'update');
    const { values } = readRow('update', ['a@x.io', 'Co'], small);
    expect(values).toEqual({ email: 'a@x.io', company: 'Co', tags: [] });
  });
});

describe('sample files stay valid', () => {
  it.each(['create', 'update'] as const)('%s sample parses and every row passes validation', (mode) => {
    const { header, rows } = parseCsv(Buffer.from(FORMATS[mode].sample), 100);
    const map = mapColumns(header, mode);
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(readRow(mode, r, map).errors).toEqual([]);
  });
});
