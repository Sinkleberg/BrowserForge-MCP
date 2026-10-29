import { api } from './browser-api.js';

export interface Settings {
  serverUrl: string;
  token: string;
  autoConnect: boolean;
  browserId: string;
  /** Auto-approve every approval request. Only the popup (a human) may change it; never exposed to the server or pages. */
  yolo: boolean;
  /** Play a chime when an approval is waiting. */
  approvalSound: boolean;
  capture: { enabled: boolean; captureBodies: boolean; tabIds: number[] | null; maxBodyBytes: number };
}

export interface ActivityItem {
  at: number;
  action: string;
  summary: string;
  tabId?: number;
  outcome: 'ok' | 'error' | 'pending' | 'denied';
}

export interface PendingApproval {
  id: string;
  title: string;
  detail: string;
  host: string;
  createdAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  serverUrl: 'ws://127.0.0.1:7345/ext',
  token: '',
  autoConnect: false,
  browserId: '',
  yolo: false,
  approvalSound: true,
  capture: { enabled: true, captureBodies: false, tabIds: null, maxBodyBytes: 200_000 },
};

export const runtime = {
  connected: false,
  connecting: false,
  lastError: '' as string,
  /** Set by the Pause button / agent pause. Refuses all agent actions. */
  paused: false,
  /** Set by the human pressing STOP/Pause in the popup: the agent cannot resume. */
  humanLocked: false,
  selectedTabId: null as number | null,
  approvalWindowId: null as number | null,
  /** Last browser window of type 'normal' that had focus: the approval popup must never count as "the active tab". */
  lastNormalWindowId: null as number | null,
};

let settings: Settings = structuredClone(DEFAULT_SETTINGS);

export async function loadSettings(): Promise<Settings> {
  const stored = (await api.storage.local.get('settings')) as { settings?: Partial<Settings> };
  settings = { ...structuredClone(DEFAULT_SETTINGS), ...(stored.settings ?? {}), capture: { ...DEFAULT_SETTINGS.capture, ...(stored.settings?.capture ?? {}) } };
  if (!settings.browserId) {
    settings.browserId = `br-${crypto.randomUUID()}`;
    await saveSettings();
  }
  return settings;
}

export function getSettings(): Settings {
  return settings;
}

export async function saveSettings(patch: Partial<Settings> = {}): Promise<void> {
  settings = { ...settings, ...patch };
  await api.storage.local.set({ settings });
}

// Activity log lives in memory (the event page / service worker may restart; it is only a convenience view).
export const activity: ActivityItem[] = [];
export function logActivity(item: Omit<ActivityItem, 'at'>): ActivityItem {
  const full = { at: Date.now(), ...item };
  activity.push(full);
  if (activity.length > 500) activity.shift();
  return full;
}

export interface ApprovalRecord {
  id: string;
  requestedAt: number;
  decidedAt: number;
  title: string;
  detail: string;
  host: string;
  outcome: 'approved' | 'denied' | 'timeout' | 'cancelled';
  by: 'human' | 'yolo' | 'system';
}

const HISTORY_KEY = 'approvalHistory';
const HISTORY_MAX = 1000;
let historyWrite: Promise<void> = Promise.resolve();

/** Serialised read-modify-write so concurrent approvals cannot drop each other's records. */
export function recordApproval(rec: ApprovalRecord): Promise<void> {
  historyWrite = historyWrite.then(async () => {
    try {
      const cur = ((await api.storage.local.get(HISTORY_KEY)) as { [HISTORY_KEY]?: ApprovalRecord[] })[HISTORY_KEY] ?? [];
      cur.push(rec);
      await api.storage.local.set({ [HISTORY_KEY]: cur.slice(-HISTORY_MAX) });
    } catch {
      /* history is best effort; never block an approval on storage */
    }
  });
  return historyWrite;
}
export async function loadApprovalHistory(): Promise<ApprovalRecord[]> {
  await historyWrite;
  return ((await api.storage.local.get(HISTORY_KEY)) as { [HISTORY_KEY]?: ApprovalRecord[] })[HISTORY_KEY] ?? [];
}
export async function clearApprovalHistory(): Promise<void> {
  historyWrite = historyWrite.then(() => api.storage.local.set({ [HISTORY_KEY]: [] }));
  await historyWrite;
}

export const pendingApprovals = new Map<string, PendingApproval & { resolve: (approved: boolean) => void }>();

export function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').host;
  } catch {
    return '';
  }
}

/** URL without query/fragment: safe to show in logs. */
export function safeUrl(url: string | undefined): string {
  try {
    const u = new URL(url ?? '');
    return `${u.origin}${u.pathname}`;
  } catch {
    return '';
  }
}
