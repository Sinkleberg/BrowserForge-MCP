import fs from 'node:fs';
import path from 'node:path';
import { ID_RE, type SettingValue } from '@browserforge/plugin-sdk';
import type { InstalledPlugin } from './types.js';

const checkId = (id: string): string => {
  if (!ID_RE.test(id)) throw new Error(`Invalid plugin id '${id}'`);
  return id;
};

/** Where installed plugins live: <config>/plugins.json (the list) and <config>/plugins/<id>/{pkg,data,settings.json}. */
export class PluginStore {
  readonly root: string;
  private readonly file: string;

  constructor(configDir: string) {
    this.root = path.join(configDir, 'plugins');
    this.file = path.join(configDir, 'plugins.json');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  list(): InstalledPlugin[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { plugins?: InstalledPlugin[] };
      return (raw.plugins ?? []).filter((p) => ID_RE.test(p.id));
    } catch {
      return [];
    }
  }
  get(id: string): InstalledPlugin | undefined {
    return this.list().find((p) => p.id === id);
  }
  private save(list: InstalledPlugin[]): void {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ plugins: list }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
  upsert(rec: InstalledPlugin): void {
    checkId(rec.id);
    this.save([...this.list().filter((p) => p.id !== rec.id), rec]);
  }
  setEnabled(id: string, enabled: boolean): boolean {
    const list = this.list();
    const rec = list.find((p) => p.id === id);
    if (!rec) return false;
    rec.enabled = enabled;
    this.save(list);
    return true;
  }
  remove(id: string): boolean {
    const had = this.get(id);
    this.save(this.list().filter((p) => p.id !== id));
    fs.rmSync(this.pluginDir(id), { recursive: true, force: true });
    return Boolean(had);
  }

  pluginDir(id: string): string {
    return path.join(this.root, checkId(id));
  }
  dataDir(id: string): string {
    const d = path.join(this.pluginDir(id), 'data');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  pkgRoot(rec: Pick<InstalledPlugin, 'id' | 'packageName'>): string {
    return path.join(this.pluginDir(rec.id), 'pkg', 'node_modules', ...rec.packageName.split('/'));
  }

  settings(id: string): Record<string, SettingValue> {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.pluginDir(id), 'settings.json'), 'utf8')) as Record<string, SettingValue>;
    } catch {
      return {};
    }
  }
  setSettings(id: string, patch: Record<string, SettingValue | null>): Record<string, SettingValue> {
    const next: Record<string, SettingValue> = { ...this.settings(id) };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    fs.mkdirSync(this.pluginDir(id), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(this.pluginDir(id), 'settings.json'), JSON.stringify(next, null, 2), { mode: 0o600 });
    return next;
  }
}
