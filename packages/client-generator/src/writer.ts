import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserForgeError, containsStrongSecret, minimalEnv, resolveSafePath } from '@browserforge/shared';
import { GENERATED_MARKER, type GeneratedClient } from './params.js';

export interface CheckResult { name: string; status: 'passed' | 'failed' | 'skipped'; output: string }
export interface WriteResult { outDir: string; files: string[]; checks: CheckResult[]; success: boolean }

export interface WriteOptions {
  outDir: string;
  allowedRoots: string[];
  overwrite?: boolean;
  /** Literal strings (captured tokens, keys, cookies) that must never appear in generated output. */
  forbiddenStrings?: string[];
  validate?: boolean;
  checkTimeoutMs?: number;
}

/** Throws if any generated file contains a forbidden literal or something that looks like a credential. */
export function scanForSecrets(files: Record<string, string>, forbidden: string[] = []): void {
  const needles = forbidden.filter((s) => s.length >= 6);
  for (const [name, content] of Object.entries(files)) {
    if (containsStrongSecret(content) || needles.some((n) => content.includes(n))) {
      throw new BrowserForgeError('GENERATION_FAILED', `Refusing to write ${name}: it contains something that looks like a credential`);
    }
  }
}

function run(cmd: string[], cwd: string, timeoutMs: number): Promise<CheckResult & { name: string }> {
  return new Promise((resolve) => {
    execFile(cmd[0]!, cmd.slice(1), { cwd, timeout: timeoutMs, maxBuffer: 2_000_000, env: minimalEnv() }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim().slice(-3000);
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return resolve({ name: cmd[0]!, status: 'skipped', output: `${cmd[0]} is not installed` });
      resolve({ name: cmd.join(' '), status: err ? 'failed' : 'passed', output });
    });
  });
}

export async function writeClient(gen: GeneratedClient, opts: WriteOptions): Promise<WriteResult> {
  const outDir = resolveSafePath(opts.outDir, opts.allowedRoots);
  scanForSecrets(gen.files, opts.forbiddenStrings);
  const markerPath = path.join(outDir, GENERATED_MARKER);
  const ours = fs.existsSync(markerPath);
  const targets = Object.keys(gen.files).map((rel) => ({ rel, abs: resolveSafePath(path.join(outDir, rel), [outDir]) }));
  const conflicts = targets.filter((t) => fs.existsSync(t.abs)).map((t) => t.rel);
  if (conflicts.length && !ours && !opts.overwrite) {
    throw new BrowserForgeError('PERMISSION_DENIED', `Output would overwrite ${conflicts.length} existing file(s) not created by BrowserForge (${conflicts.slice(0, 5).join(', ')}). Choose an empty directory or pass overwrite:true.`);
  }
  fs.mkdirSync(outDir, { recursive: true, mode: 0o755 });
  for (const t of targets) {
    fs.mkdirSync(path.dirname(t.abs), { recursive: true });
    fs.writeFileSync(t.abs, gen.files[t.rel]!, { mode: 0o644 });
  }
  fs.writeFileSync(markerPath, `Created by BrowserForge MCP (${gen.language}). Files listed here may be regenerated.\n${Object.keys(gen.files).join('\n')}\n`);
  const checks: CheckResult[] = [];
  if (opts.validate !== false) for (const c of gen.checks) {
    const r = await run(c.cmd, outDir, opts.checkTimeoutMs ?? 120_000);
    checks.push({ ...r, name: c.name });
  }
  return { outDir, files: Object.keys(gen.files), checks, success: checks.every((c) => c.status !== 'failed') };
}
