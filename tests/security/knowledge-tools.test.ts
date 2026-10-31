import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startStack, type Stack } from '../helpers/stack.js';
import { createApp } from '../../apps/mcp-server/src/app.js';

describe('knowledge tools: path safety and privacy', () => {
  let stack: Stack;
  let outside: string;
  beforeAll(async () => {
    stack = await startStack();
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'bf-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret outside the allowed folders');
    fs.writeFileSync(path.join(stack.home, 'files', 'notes.md'), '# Notes\n\nThe visa appointment is on Tuesday.');
  });
  afterAll(async () => {
    fs.rmSync(outside, { recursive: true, force: true });
    await stack.close();
  });

  it('refuses documents outside the allowed upload directories, and symlinks out of them', async () => {
    const r = await stack.call('knowledge_add_document', { path: path.join(outside, 'secret.txt') });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('PATH_NOT_ALLOWED');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(stack.home, 'files', 'link.txt'));
    expect((await stack.call('knowledge_add_document', { path: path.join(stack.home, 'files', 'link.txt') })).data.error.code).toBe('PATH_NOT_ALLOWED');
    expect(JSON.stringify((await stack.call('knowledge_search', { query: 'secret' })).data)).not.toContain('top secret');
  });

  it('indexes an allowed document and returns search hits marked as untrusted data', async () => {
    const add = await stack.call('knowledge_add_document', { path: path.join(stack.home, 'files', 'notes.md') });
    expect(add.isError).toBe(false);
    const found = await stack.call('knowledge_search', { query: 'visa appointment' });
    expect(found.data.untrustedWebContent).toBe(true);
    expect(found.data.data[0].text).toContain('Tuesday');
    const list = await stack.call('knowledge_list');
    expect(list.data.documents).toHaveLength(1);
    expect(list.data.decider.qwen.reachable).toBeTypeOf('boolean');
    expect(list.data.decider.laya.reachable).toBeTypeOf('boolean');
    expect(list.data.decider.mode).toBe('qwen'); // measured: Qwen beats Laya on page steps, so it is the default
    expect((await stack.call('knowledge_remove', { id: list.data.documents[0].id })).data.removed).toBe(true);
  });

  it('exports datasets only into the allowed export directories and only as .jsonl', async () => {
    expect((await stack.call('knowledge_export_dataset', { path: path.join(outside, 'x.jsonl') })).data.error.code).toBe('PATH_NOT_ALLOWED');
    expect((await stack.call('knowledge_export_dataset', { path: path.join(stack.home, 'exports', 'x.txt') })).data.error.code).toBe('INVALID_ARGUMENTS');
    const ok = await stack.call('knowledge_export_dataset', { path: path.join(stack.home, 'exports', 'train.jsonl') });
    expect(ok.isError).toBe(false);
    expect(ok.data.examples).toBe(0);
  });

  it('browser_run_goal reports a missing browser instead of acting, and rejects out-of-range arguments', async () => {
    const r = await stack.call('browser_run_goal', { goal: 'Sign up', inputs: { name: 'Ada' } });
    expect(r.isError).toBe(true);
    expect(r.data.error.code).toBe('NOT_CONNECTED');
    expect((await stack.call('browser_run_goal', { goal: 'x'.repeat(600) })).isError).toBe(true);
    expect((await stack.call('browser_run_goal', { goal: 'Sign up', maxSteps: 500 })).isError).toBe(true);
  });

  it('refuses to start with a decider that is not on this machine', () => {
    expect(() => createApp({ port: 0, configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cfg-')), decider: { mode: 'cascade', url: 'http://10.0.0.5:11434', model: 'm', minConfidence: 0.7, timeoutMs: 1000, laya: { url: '', model: '', minConfidence: 0.5 } } })).toThrow(/this machine/);
    expect(() => createApp({ port: 0, configDir: fs.mkdtempSync(path.join(os.tmpdir(), 'bf-cfg-')), decider: { mode: 'cascade', url: '', model: '', minConfidence: 0.7, timeoutMs: 1000, laya: { url: 'http://192.168.1.9:11435', model: 'laya', minConfidence: 0.5 } } })).toThrow(/this machine/);
  });
});
