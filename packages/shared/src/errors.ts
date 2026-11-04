export type ErrorCode =
  | 'INVALID_ARGUMENTS'
  | 'UNAUTHORIZED'
  | 'NOT_CONNECTED'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'TAB_NOT_FOUND'
  | 'ELEMENT_NOT_FOUND'
  | 'ELEMENT_DISABLED'
  | 'STALE_REF'
  | 'NAVIGATION_FAILED'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_DENIED'
  | 'PAUSED'
  | 'STOPPED'
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'PATH_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'LIMIT_EXCEEDED'
  | 'GENERATION_FAILED'
  | 'INTERNAL';

export interface PublicError {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

/** Error whose message is safe to show to an agent/user (never contains stack traces or secrets). */
export class BrowserForgeError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'BrowserForgeError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }

  toPublic(): PublicError {
    const out: PublicError = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details) out.details = this.details;
    return out;
  }
}

/** Convert any thrown value into a PublicError without leaking stacks or internals. */
export function toPublicError(err: unknown): PublicError {
  if (err instanceof BrowserForgeError) return err.toPublic();
  return { code: 'INTERNAL', message: 'Internal error (see server log for details)', retryable: false };
}
