import type { Header } from '@browserforge/shared';

export interface CapturedRequest {
  /** Stable id within the store, e.g. "r_000123". */
  id: string;
  captureId: string;
  browserId?: string;
  tabId?: number;
  url: string;
  method: string;
  requestHeaders: Header[];
  requestBody?: string;
  requestBodyTruncated?: boolean;
  status?: number;
  statusText?: string;
  responseHeaders: Header[];
  responseBody?: string;
  responseBodyBase64?: boolean;
  responseBodyTruncated?: boolean;
  mimeType?: string;
  resourceType?: string;
  initiator?: string;
  startedAt: number;
  durationMs?: number;
  fromCache?: boolean;
  error?: string;
}

export interface RequestFilter {
  /** Exact host ("api.example.com") or wildcard ("*.example.com"). */
  hostname?: string;
  /** Glob over the full URL; `*` matches any run of characters. Plain text matches as substring. */
  urlPattern?: string;
  method?: string | string[];
  /** 200, "2xx", "400-499" or a list of those. */
  status?: number | string | (number | string)[];
  contentType?: string;
  tabId?: number;
  browserId?: string;
  resourceType?: string;
  since?: number;
  until?: number;
  hasResponseBody?: boolean;
}

export interface Capture {
  id: string;
  label: string;
  source: 'live' | 'har' | 'api';
  createdAt: number;
  requests: CapturedRequest[];
}

export interface Page<T> {
  items: T[];
  total: number;
  nextCursor?: string;
}

export interface ViewOptions {
  /** Return unredacted values. Only honoured by callers that have checked policy. */
  reveal?: boolean;
  includeBodies?: boolean;
  maxBodyChars?: number;
}

export interface RequestSummary {
  id: string;
  captureId: string;
  method: string;
  url: string;
  host: string;
  path: string;
  status?: number;
  mimeType?: string;
  resourceType?: string;
  tabId?: number;
  startedAt: string;
  durationMs?: number;
  requestBodyBytes?: number;
  responseBodyBytes?: number;
}

export interface RequestDetails extends RequestSummary {
  query: Record<string, string[]>;
  requestHeaders: Header[];
  requestBody?: string;
  requestBodyTruncated?: boolean;
  responseHeaders: Header[];
  responseBody?: string;
  responseBodyTruncated?: boolean;
  responseBodyBase64?: boolean;
  initiator?: string;
  fromCache?: boolean;
  error?: string;
  redacted: boolean;
}
