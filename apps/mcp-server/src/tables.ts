/** One table as the extension reports it. Cells are text; merged cells are already expanded into the cells they cover. */
export interface PageTable {
  index: number;
  kind: 'table' | 'grid';
  caption: string;
  headers: string[] | null;
  columns: number;
  rows: string[][];
  links?: (string | null)[][];
  merges: { row: number; col: number; rowSpan: number; colSpan: number }[];
  totalRows: number;
  truncated: boolean;
  frame?: { frameId: number; url: string };
}

/**
 * A cell that starts with = + - @ (or a tab / carriage return) is read as a formula by Excel and Sheets, and these cells come from web
 * pages. A leading apostrophe keeps them as text.
 */
export function safeCell(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

const csvField = (v: string): string => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** RFC 4180 CSV (CRLF line ends), headers first when there are any. */
export function toCsv(headers: string[] | null, rows: string[][]): string {
  const lines = [...(headers ? [headers] : []), ...rows].map((r) => r.map((c) => csvField(safeCell(c))).join(','));
  return lines.join('\r\n') + (lines.length ? '\r\n' : '');
}

/** Rows as objects keyed by the column names (every key present, so the shape is the same for each row). */
export function toRecords(headers: string[], rows: string[][]): Record<string, string>[] {
  return rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
}
