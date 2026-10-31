import fs from 'node:fs';
import path from 'node:path';

export interface LogFile {
  write(line: string): void;
  /** The file being written right now. */
  current(): string;
  readonly dir: string;
  close(): void;
}

export interface LogFileOptions {
  /** Delete log files older than this many days (default 14). */
  retentionDays?: number;
  /** Start a new file after this many bytes in one day (default 20 MB). */
  maxBytes?: number;
  now?: () => number;
}

const NAME = /^server-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.log$/;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * A daily-rotating, private (0600) log file: server-YYYY-MM-DD.log, then .1, .2 when a day exceeds maxBytes.
 * Writing can never break the program that is logging: every failure is swallowed.
 */
export function createLogFile(dir: string, opts: LogFileOptions = {}): LogFile {
  const now = opts.now ?? Date.now;
  const retention = (opts.retentionDays ?? 14) * 86_400_000;
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024;
  let fd: number | undefined;
  let curDay = '';
  let part = 0;
  let size = 0;
  let file = '';

  const pathFor = (d: string, p: number) => path.join(dir, p === 0 ? `server-${d}.log` : `server-${d}.${p}.log`);

  const prune = () => {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = NAME.exec(f);
        if (m && Date.parse(m[1]!) < now() - retention) fs.rmSync(path.join(dir, f), { force: true });
      }
    } catch {
      /* nothing to prune */
    }
  };

  const open = () => {
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } catch {
      /* already closed */
    }
    fd = undefined;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      file = pathFor(curDay, part);
      fd = fs.openSync(file, 'a', 0o600);
      size = fs.fstatSync(fd).size;
    } catch {
      fd = undefined;
    }
  };

  const roll = () => {
    const d = day(now());
    if (d !== curDay) {
      curDay = d;
      part = 0;
      while (fs.existsSync(pathFor(curDay, part + 1))) part++; // continue the newest part after a restart
      open();
      prune();
    }
    if (size >= maxBytes) {
      part++;
      open();
    }
  };

  return {
    dir,
    current: () => file || pathFor(day(now()), 0),
    write(line) {
      try {
        roll();
        if (fd === undefined) return;
        const text = (line.length > 8000 ? `${line.slice(0, 8000)}...` : line) + '\n';
        fs.writeSync(fd, text);
        size += text.length;
      } catch {
        /* a full disk or a removed folder must not take the server down */
      }
    },
    close() {
      try {
        if (fd !== undefined) fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      fd = undefined;
    },
  };
}

export interface LogLine {
  t: string;
  level: string;
  msg: string;
  [k: string]: unknown;
}

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Read saved log lines, oldest first. `sinceMs` is a period ("the last N ms"). Damaged lines are skipped. */
export function readLogs(dir: string, opts: { sinceMs?: number; minLevel?: string; tail?: number; now?: number } = {}): LogLine[] {
  let files: string[];
  try {
    files = fs
      .readdirSync(dir)
      .map((f) => ({ f, m: NAME.exec(f) }))
      .filter((x): x is { f: string; m: RegExpExecArray } => x.m !== null)
      .sort((a, b) => a.m[1]!.localeCompare(b.m[1]!) || Number(a.m[2] ?? 0) - Number(b.m[2] ?? 0))
      .map((x) => path.join(dir, x.f));
  } catch {
    return [];
  }
  const min = LEVELS[opts.minLevel ?? 'debug'] ?? 10;
  const since = opts.sinceMs === undefined ? 0 : (opts.now ?? Date.now()) - opts.sinceMs;
  const out: LogLine[] = [];
  for (const f of files) {
    let text: string;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        const l = JSON.parse(line) as LogLine;
        if ((LEVELS[l.level] ?? 0) >= min && Date.parse(l.t) >= since) out.push(l);
      } catch {
        /* torn line */
      }
    }
  }
  return opts.tail ? out.slice(-opts.tail) : out;
}
