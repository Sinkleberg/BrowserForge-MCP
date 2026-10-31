import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchChromium, launchFirefox, type BrowserHandle } from '../helpers/browsers.js';
import { startStack, type Stack } from '../helpers/stack.js';

const kinds = (process.env.BF_BROWSERS ?? 'firefox,chromium').split(',') as ('firefox' | 'chromium')[];

describe.each(kinds)('browser_extract_table — %s', (kind) => {
  let stack: Stack;
  let browser: BrowserHandle;
  beforeAll(async () => {
    stack = await startStack();
    browser = kind === 'firefox' ? await launchFirefox(stack.app) : await launchChromium(stack.app);
    await browser.openPage(stack.demo.url + '/tables');
    await stack.call('browser_get_tabs');
  });
  afterAll(async () => {
    await browser?.close();
    await stack?.close();
  });
  const extract = async (a: Record<string, unknown> = {}) => (await stack.call('browser_extract_table', a)).data;

  it('lists the real data tables (and not layout or hidden ones), including the one in an iframe', async () => {
    const d = (await extract()).data;
    expect(d.found).toBe(3);
    expect(d.tables.map((t: any) => [t.caption ?? '', t.headers])).toEqual([
      ['Open roles', ['Role', 'Team', 'Apply']],
      ['Scores', ['Player', 'Score']],
      ['', ['Item', 'Qty']],
    ]);
    expect(d.tables[2].frame).toBeTruthy();
  });

  it('expands merged cells so columns do not shift, and reports the merges', async () => {
    const d = (await extract({ tableIndex: 0, includeLinks: true })).data;
    expect(d.records).toEqual([
      { Role: 'AI Engineer', Team: 'Research', Apply: 'Apply' },
      { Role: 'ML Engineer', Team: 'Research', Apply: 'Apply' },
      { Role: '=HYPERLINK("http://evil.test","click")', Team: '=HYPERLINK("http://evil.test","click")', Apply: '' },
    ]);
    expect(d.merges).toEqual([{ row: 1, col: 1, rowSpan: 2, colSpan: 1 }, { row: 3, col: 0, rowSpan: 1, colSpan: 2 }]);
    expect(d.links[0][2]).toMatch(/\/apply\/1$/);
    expect(d.links[1][2]).toMatch(/\/apply\/2$/);
    expect(d.links[0][0]).toBeNull();
  });

  it('reads an ARIA grid and a table in an iframe', async () => {
    expect((await extract({ tableIndex: 1 })).data.records).toEqual([{ Player: 'Ada', Score: '10' }, { Player: 'Grace', Score: '12' }]);
    expect((await extract({ tableIndex: 2 })).data.records).toEqual([{ Item: 'Pens', Qty: '3' }]);
  });

  it('gives CSV that spreadsheets cannot run, and refuses to guess between several tables', async () => {
    const csv = (await extract({ tableIndex: 0, format: 'csv' })).data.csv as string;
    expect(csv.split('\r\n')[0]).toBe('Role,Team,Apply');
    expect(csv).toContain(`'=HYPERLINK("http://evil.test","click")`.replace(/"/g, '""'));
    const err = await stack.call('browser_extract_table', { format: 'csv' });
    expect(err.isError).toBe(true);
    expect(err.data.error.message).toMatch(/tableIndex/);
    expect((await stack.call('browser_extract_table', { tableIndex: 9 })).isError).toBe(true);
  });

  it('saves a big table to a file and returns only a preview, and limits rows', async () => {
    const d = (await extract({ tableIndex: 0, saveTo: 'jobs-test', format: 'csv' })).data;
    expect(d.saved).toBe(path.join(stack.home, 'exports', 'jobs-test.csv'));
    expect(d.preview.length).toBeGreaterThan(0);
    expect(fs.readFileSync(d.saved, 'utf8').startsWith('Role,Team,Apply\r\n')).toBe(true);
    expect(fs.statSync(d.saved).mode & 0o777).toBe(0o600);
    const limited = (await extract({ tableIndex: 0, maxRows: 1 })).data;
    expect(limited.records).toHaveLength(1);
    expect(limited.truncated).toBe(true);
    expect((await stack.call('browser_extract_table', { tableIndex: 0, saveTo: '../../etc/passwd' })).isError).toBe(false); // the name is flattened into the exports folder
    expect(fs.existsSync('/etc/passwd.json')).toBe(false);
  });

  it('says so, with a hint, on a page with no tables', async () => {
    await stack.call('browser_navigate', { url: stack.demo.url + '/signup' });
    const d = (await extract()).data;
    expect(d.found).toBe(0);
    expect(d.hint).toMatch(/not tables/);
  });
});
