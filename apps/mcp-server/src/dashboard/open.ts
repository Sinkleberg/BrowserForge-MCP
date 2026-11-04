import { spawn } from 'node:child_process';

/** The address that opens the dashboard. The token is in the fragment, which the browser never sends to any server. */
export function dashboardUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/dashboard#t=${encodeURIComponent(token)}`;
}

/** The program that opens a web address in the default browser. It is started without a shell, with the address as one argument. */
export function openerFor(platform: NodeJS.Platform): string {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'explorer.exe';
  return 'xdg-open';
}

/** Best effort: if there is no opener (a server with no desktop) nothing happens, and the caller has printed how to get the address. */
export function openUrl(url: string, platform: NodeJS.Platform = process.platform): void {
  const child = spawn(openerFor(platform), [url], { stdio: 'ignore', detached: true });
  child.on('error', () => undefined);
  child.unref();
}
