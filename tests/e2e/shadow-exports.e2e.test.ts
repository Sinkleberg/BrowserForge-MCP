import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getExporter, type Flow } from '@browserforge/flows';
import { findChromium } from '../helpers/browsers.js';
import { shadowFlow, UNUSUAL_HOST } from '../helpers/shadow-flow.js';
import { ROOT, startStack, waitFor, type Stack } from '../helpers/stack.js';

const exec = promisify(execFile);
const formats = ['playwright-ts', 'playwright-py', 'selenium-py', 'selenium-java'] as const;
type Format = typeof formats[number];
const available = (format: Format) => format === 'playwright-ts' || (format === 'selenium-java' ? Boolean(process.env.BF_SELENIUM_JAVA_CLASSPATH) : Boolean(process.env.BF_EXPORT_PYTHON));

describe('standalone generated open-shadow scripts', () => {
  let stack: Stack;
  let scratch: string;
  let serial = 0;
  beforeAll(async () => {
    stack = await startStack();
    scratch = fs.mkdtempSync(path.join(ROOT, 'node_modules', '.cache-shadow-exports-'));
  });
  afterAll(async () => { await stack?.close(); if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); });
  const results = async () => await (await fetch(stack.demo.url + '/shadow-results')).json() as Record<string, string>[];

  async function run(format: Format, flow: Flow, confirmed: boolean, value: string) {
    const hitStart = stack.demo.hits.length;
    const dir = path.join(scratch, `${serial++}-${format}`);
    fs.mkdirSync(dir);
    const exporter = getExporter(format)!;
    const file = path.join(dir, format === 'selenium-java' ? 'Flow.java' : `flow.${exporter.extension}`);
    const source = exporter.generate(flow);
    fs.writeFileSync(file, source);
    const env = { ...process.env, HEADLESS: '1', BROWSER_PATH: process.env.BROWSER_PATH || findChromium(), FLOW_CONFIRM: confirmed ? '1' : '0', FLOW_PARAM_SHADOW_VALUE: value };
    let command: string;
    let args: string[];
    if (format === 'playwright-ts') {
      const script = path.join(dir, 'flow.mjs');
      await exec(path.join(ROOT, 'node_modules/.bin/esbuild'), [file, '--bundle=false', '--format=esm', `--outfile=${script}`, '--log-level=error'], { cwd: dir, timeout: 60_000 });
      command = process.execPath; args = [script];
    } else if (format === 'selenium-java') {
      const cp = process.env.BF_SELENIUM_JAVA_CLASSPATH!;
      await exec('javac', ['-encoding', 'UTF-8', '-cp', cp, file], { cwd: dir, timeout: 60_000 });
      command = 'java'; args = ['-cp', [dir, cp].join(path.delimiter), 'Flow'];
    } else {
      command = process.env.BF_EXPORT_PYTHON!; args = [file];
    }
    let result: { code: number; output: string };
    try {
      const ran = await exec(command, args, { cwd: dir, env, timeout: 90_000 });
      result = { code: 0, output: ran.stdout + ran.stderr };
    } catch (error) {
      const e = error as { code?: number | string; stdout?: string; stderr?: string; message?: string };
      result = { code: typeof e.code === 'number' ? e.code : -1, output: String(e.stdout ?? '') + String(e.stderr ?? '') + String(e.message ?? '') };
    }
    if (process.env.BF_EXPORT_EVIDENCE) {
      fs.mkdirSync(process.env.BF_EXPORT_EVIDENCE, { recursive: true });
      fs.writeFileSync(path.join(process.env.BF_EXPORT_EVIDENCE, `${serial}-${format}.json`), JSON.stringify({ format, confirmed, value, sourceSha256: createHash('sha256').update(source).digest('hex'), result, fixtureHits: stack.demo.hits.slice(hitStart), fixturePosts: await results() }, null, 2));
    }
    return result;
  }

  for (const format of formats) it.skipIf(!available(format))(`${format} executes the intended root/iframe, keeps selector data inert, and refuses unsafe scopes`, async () => {
    let before = (await results()).length;
    const stopped = await run(format, shadowFlow(stack.demo.url), false, 'not-submitted');
    expect(stopped.code, stopped.output).toBe(3);
    expect(stopped.output).toContain('FLOW_CONFIRM');
    expect((await results()).length).toBe(before);
    for (const opts of [{}, { frame: true }, { unusual: true }]) {
      before = (await results()).length;
      const value = `${format}-${'frame' in opts ? 'frame' : 'unusual' in opts ? 'quoted' : 'root'}`;
      const ran = await run(format, shadowFlow(stack.demo.url, { ...opts, verifyResponse: true }), true, value);
      expect(ran.code, ran.output).toBe(0);
      try {
        await waitFor(async () => (await results()).length > before, { what: 'standalone shadow form POST' });
      } catch (error) {
        if (process.env.BF_EXPORT_EVIDENCE) fs.writeFileSync(path.join(process.env.BF_EXPORT_EVIDENCE, `${serial}-${format}-missing-post.json`), JSON.stringify({ format, value, result: ran, fixtureHits: stack.demo.hits, fixturePosts: await results() }, null, 2));
        throw error; // Keep the real failure; successful script exit alone never proves the intended action.
      }
      expect((await results()).slice(before)).toEqual([{ first: '', second: value, outer: 'unusual' in opts ? UNUSUAL_HOST : 'target', inner: '2', page: '/shadow-nested' }]);
    }
    for (const bad of [
      { shadow: ['#missing'], css: 'input[name="second"]' },
      { shadow: ['outer-box'], css: 'input[name="second"]' },
      { shadow: ['#closed'], css: 'input[name="second"]' },
      { shadow: ['#target', 'inner-box:nth-of-type(2)'], css: 'input' },
    ]) {
      before = (await results()).length;
      const flow = shadowFlow(stack.demo.url);
      Object.assign(flow.steps[1]!.locator!, bad);
      const refused = await run(format, flow, true, 'must-not-be-submitted');
      expect(refused.code, refused.output).toBe(1);
      expect(refused.output).toMatch(/No (unique open-shadow )?element found/);
      expect((await results()).length).toBe(before);
    }
  });
});
