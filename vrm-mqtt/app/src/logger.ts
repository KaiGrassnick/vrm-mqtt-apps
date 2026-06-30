export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

/** Falls back to 'info' for an unset or unrecognised value. */
export function resolveLevel(raw: string | undefined): LogLevel {
  const normalized = raw?.toLowerCase();
  return normalized !== undefined && normalized in LEVEL_ORDER
    ? (normalized as LogLevel)
    : 'info';
}

/**
 * Minimal leveled logger. Lets an operator quiet noisy debug output (e.g.
 * "Subscribed N topics" on every connect) via the LOG_LEVEL env var, without
 * a code change — and gives every log call site one place to route through.
 */
export class Logger {
  constructor(private level: LogLevel) {}

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  getLevel(): LogLevel {
    return this.level;
  }

  private enabled(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
  }

  debug(...args: unknown[]): void {
    if (this.enabled('debug')) console.debug(...args);
  }

  info(...args: unknown[]): void {
    if (this.enabled('info')) console.log(...args);
  }

  warn(...args: unknown[]): void {
    if (this.enabled('warn')) console.warn(...args);
  }

  error(...args: unknown[]): void {
    if (this.enabled('error')) console.error(...args);
  }
}

export const logger = new Logger(resolveLevel(process.env.LOG_LEVEL));
