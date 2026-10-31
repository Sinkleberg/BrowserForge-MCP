import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The variables a child process (a plugin's command, a code generator's compiler) may inherit: enough to find programs and a home
 * folder on every platform, and nothing else, so tokens and API keys in the server's environment never reach it.
 */
export function minimalEnv(): NodeJS.ProcessEnv {
  const keep = process.platform === 'win32'
    ? ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'windir']
    : ['PATH', 'HOME', 'TMPDIR'];
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8' };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  if (process.platform !== 'win32') env.PATH ??= '';
  return env;
}

/**
 * How to run npm without a shell. On Windows npm is a .cmd file, which Node refuses to start directly (and a shell would defeat the
 * argument checks), so run npm's own script with the node that runs us.
 */
export function npmInvocation(): { command: string; args: string[] } {
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  const cli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(cli)) return { command: process.execPath, args: [cli] };
  throw new Error('Could not find npm next to node. Reinstall Node.js with npm included, or install the plugin yourself with: npm install <package> --ignore-scripts inside the plugin folder.');
}

/** A plugin source that is a folder on disk (relative, absolute, home-relative, a Windows drive or a UNC path), as opposed to a package name or URL. */
export function isPathSpec(spec: string): boolean {
  return /^(\.|\/|~|[A-Za-z]:[\\/]|\\\\)/.test(spec);
}

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}
