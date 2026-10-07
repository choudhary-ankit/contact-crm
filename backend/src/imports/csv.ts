import { parse } from 'csv-parse/sync';

export class CsvFormatError extends Error {}

export interface ParsedCsv {
  header: string[];
  rows: string[][];
}

/** RFC 4180 parsing (quotes, embedded commas/newlines, CRLF, UTF-8 BOM). Blank lines are skipped. */
export function parseCsv(buf: Buffer, maxRows: number): ParsedCsv {
  let records: string[][];
  try {
    records = parse(buf, {
      bom: true,
      record_delimiter: ['\r\n', '\n', '\r'], // files in the wild mix line endings
      skip_empty_lines: true,
      relax_column_count: true,
      max_record_size: 20_000,
      trim: false,
    });
  } catch (e: any) {
    throw new CsvFormatError(`The file is not valid CSV (${String(e?.message ?? e).split('\n')[0]})`);
  }
  if (!records.length) throw new CsvFormatError('The file is empty');
  const [header, ...rows] = records;
  if (rows.length > maxRows) throw new CsvFormatError(`The file has ${rows.length.toLocaleString('en-US')} rows; the limit is ${maxRows.toLocaleString('en-US')}`);
  return { header, rows };
}

// ---------------------------------------------------------------- columns

export type Column = 'first_name' | 'last_name' | 'email' | 'phone' | 'company' | 'tags';

const ALIASES: Record<string, Column> = {
  first_name: 'first_name', firstname: 'first_name', given_name: 'first_name',
  last_name: 'last_name', lastname: 'last_name', surname: 'last_name', family_name: 'last_name',
  email: 'email', email_address: 'email', e_mail: 'email',
  phone: 'phone', phone_number: 'phone', mobile: 'phone',
  company: 'company', company_name: 'company', organization: 'company',
  tags: 'tags', tag: 'tags',
};

export const normalizeHeader = (h: string) => h.replace(/^﻿/, '').trim().toLowerCase().replace(/[\s-]+/g, '_');

export interface ColumnMap {
  index: Partial<Record<Column, number>>;
  /** columns that were in the file but are not part of the format (ignored) */
  ignored: string[];
}

/** Maps header names to canonical columns. Throws CsvFormatError for problems that make the whole file unusable. */
export function mapColumns(header: string[], mode: 'create' | 'update'): ColumnMap {
  const index: Partial<Record<Column, number>> = {};
  const ignored: string[] = [];
  header.forEach((raw, i) => {
    const col = ALIASES[normalizeHeader(raw)];
    if (!col) {
      if (raw.trim()) ignored.push(raw.trim());
      return;
    }
    if (index[col] !== undefined) throw new CsvFormatError(`The column "${col}" appears twice in the header`);
    index[col] = i;
  });

  const required: Column[] = mode === 'create' ? ['first_name', 'last_name'] : ['email'];
  const missing = required.filter((c) => index[c] === undefined);
  if (missing.length) throw new CsvFormatError(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`);
  if (mode === 'update' && Object.keys(index).length < 2) {
    throw new CsvFormatError('An update file needs the email column plus at least one column to change');
  }
  return { index, ignored };
}

// ---------------------------------------------------------------- writing

/**
 * Neutralises spreadsheet formula injection in exported cells ("=cmd|...", "@SUM(..)", "-2+3", "+cmd").
 * Phone-like values such as "+1 (415) 555-0172" are left alone so exports round-trip into update files.
 */
export function csvSafe(cell: string): string {
  if (/^[=@\t\r]/.test(cell) || /^[+-](?![\d\s().-]*$)/.test(cell)) return `'${cell}`;
  return cell;
}

const quote = (cell: string) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

export const toCsvLine = (cells: string[]) => cells.map((c) => quote(csvSafe(c))).join(',') + '\r\n';
