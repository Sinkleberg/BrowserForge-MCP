import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readLogs } from '@browserforge/shared';
import { startStack, waitFor, type Stack } from '../helpers/stack.js';
import { connectFake } from '../helpers/fake-extension.js';

let stack: Stack;
beforeAll(async () => { stack = await startStack(); });
afterAll(async () => { await stack.close(); });

const logs = () => readLogs(path.join(stack.home, 'logs'));

describe('persistent log', () => {
  it('records the server start and a failed tool call with its code and timing', async () => {
    const r = await stack.call('browser_get_tabs');
    expect(r.data.error.code).toBe('NOT_CONNECTED');
    await waitFor(() => logs().some((l) => l.msg === 'tool error'));
    const started = logs().find((l) => l.msg === 'server created');
    expect(started).toMatchObject({ decider: 'qwen' });
    const failed = logs().find((l) => l.msg === 'tool error' && l.tool === 'browser_get_tabs')!;
    expect(failed).toMatchObject({ code: 'NOT_CONNECTED' });
    expect(typeof failed.ms).toBe('number');
  });

  it('records what the browser did and what the server asked of it, without any typed values', async () => {
    const fake = await connectFake(stack.app.port, { id: 'br-log-test', token: stack.app.ctx.config.extensionToken });
    fake.onRequest = (req) => {
      if (req.action === 'type') throw Object.assign(new Error('Target is not a form field'), { code: 'ELEMENT_NOT_FOUND' });
      return { tabs: [] };
    };
    try {
      await waitFor(() => stack.app.ctx.hub.listPeers().length > 0);
      await stack.call('browser_get_tabs');
      const typed = await stack.call('browser_type', { ref: '1:2', text: 'TOPSECRETTEXT-9137' });
      expect(typed.isError).toBe(true);
      fake.ws.send(JSON.stringify({ v: 1, type: 'event', event: 'activity', data: { at: Date.now(), action: 'click', summary: 'click on example.com (1:5)', tabId: 7, outcome: 'ok' } }));
      await waitFor(() => logs().some((l) => l.msg === 'browser activity'));
    } finally {
      fake.close();
    }
    const all = logs();
    expect(all.find((l) => l.msg === 'browser activity')).toMatchObject({ action: 'click', tab: 7, outcome: 'ok' });
    expect(all.find((l) => l.msg === 'action failed' && l.action === 'type')).toMatchObject({ action: 'type', code: 'ELEMENT_NOT_FOUND' });
    expect(fs.readFileSync(path.join(stack.home, 'logs', fs.readdirSync(path.join(stack.home, 'logs'))[0]!), 'utf8')).not.toContain('TOPSECRETTEXT-9137');
  });

  it('records how big each reply was so costly tools can be found', async () => {
    await stack.call('system_status');
    await waitFor(() => logs().some((l) => l.msg === 'tool ok' && l.tool === 'system_status'));
    const ok = logs().filter((l) => l.msg === 'tool ok' && l.tool === 'system_status').pop()!;
    expect(ok.chars).toBeGreaterThan(50);
    expect(ok.approxTokens).toBe(Math.ceil((ok.chars as number) / 4));
  });

  it('system_diagnostics says where the log is and how to read it', async () => {
    const d = (await stack.call('system_diagnostics')).data;
    expect(d.logs.file).toMatch(/server-\d{4}-\d{2}-\d{2}\.log$/);
    expect(d.logs.readWith).toMatch(/browserforge logs/);
  });
});
