import { describe, expect, it } from 'vitest';
import { safeCell, toCsv, toRecords } from '../../apps/mcp-server/src/tables.js';

describe('table export helpers', () => {
  it('writes RFC 4180 CSV: quotes, commas and line breaks inside cells, CRLF between lines', () => {
    const csv = toCsv(['Name', 'Note'], [['Ada', 'says "hi", twice'], ['Grace', 'two\nlines']]);
    expect(csv).toBe('Name,Note\r\nAda,"says ""hi"", twice"\r\nGrace,"two\nlines"\r\n');
  });
  it('writes rows without a header line when the table has none, and nothing for an empty table', () => {
    expect(toCsv(null, [['1', '2']])).toBe('1,2\r\n');
    expect(toCsv(null, [])).toBe('');
  });
  it('keeps web page cells from becoming spreadsheet formulas', () => {
    for (const bad of ['=HYPERLINK("http://evil.test")', '+1+1', '-2+3', '@SUM(A1)', '\tcmd', '\rcmd']) expect(safeCell(bad)).toBe(`'${bad}`);
    expect(safeCell('Ada')).toBe('Ada');
    expect(safeCell('1-2')).toBe('1-2');
    expect(toCsv(['x'], [['=1+1']])).toBe("x\r\n'=1+1\r\n");
  });
  it('makes records with every key present, even for short rows', () => {
    expect(toRecords(['a', 'b', 'c'], [['1', '2'], ['3', '4', '5']])).toEqual([{ a: '1', b: '2', c: '' }, { a: '3', b: '4', c: '5' }]);
  });
});
