import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function generateToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Where BrowserForge keeps its tokens, logs, flows and knowledge: BROWSERFORGE_HOME if set; on Windows %APPDATA%\browserforge;
 * elsewhere $XDG_CONFIG_HOME/browserforge or ~/.config/browserforge (macOS included, so the docs read the same everywhere).
 */
export function standardConfigDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.BROWSERFORGE_HOME) return env.BROWSERFORGE_HOME;
  if (platform === 'win32') return path.win32.join(env.APPDATA ?? path.win32.join(home, 'AppData', 'Roaming'), 'browserforge');
  // A POSIX path for a non-Windows platform, whatever system this code runs on (a pure function, tested for every platform everywhere).
  return path.posix.join(env.XDG_CONFIG_HOME ?? path.posix.join(home, '.config'), 'browserforge');
}

export function configDir(): string {
  const base = standardConfigDir(process.platform, process.env, os.homedir());
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  return base;
}

/** Load a persistent token (0600) or create it. */
export function loadOrCreateToken(file: string): string {
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* create below */
  }
  const token = generateToken();
  fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* Windows has no file modes: the folder inside the user's profile is what protects it */
  }
  return token;
}
