/** Central output/capture limits so every tool stays within predictable bounds. */
export const LIMITS = {
  /** Max characters returned for page text / DOM snapshots. */
  maxTextChars: 50_000,
  maxDomNodes: 2_000,
  maxInteractiveElements: 300,
  /** Max bytes of a screenshot data payload (base64 chars). */
  maxScreenshotBase64: 8_000_000,
  /** Max inbound WebSocket / HTTP message size. */
  maxMessageBytes: 12_000_000,
  maxBodyCapture: 1_000_000,
  defaultToolTimeoutMs: 30_000,
  maxToolTimeoutMs: 300_000,
  defaultPageSize: 50,
  maxPageSize: 200,
  maxCapturedRequests: 5_000,
  maxActivityLog: 500,
  maxImportHarBytes: 100_000_000,
} as const;

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}
