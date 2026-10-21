/**
 * Shared postgres client construction.
 *
 * The one thing this centralises is NOTICE routing. The `postgres` package's
 * default handler `console.log`s the entire notice object to STDOUT, where
 * scripts parse output such as `substrate federate enroll`'s token. NOTICEs go
 * to stderr instead, one compact line each.
 */

import type { Sql } from 'postgres';
import postgres from 'postgres';

/** The subset of a pg NOTICE we surface. Everything else is call-site trivia. */
interface PgNoticeLike {
  severity?: unknown;
  message?: unknown;
}

export function formatPgNotice(notice: unknown): string {
  const candidate = typeof notice === 'object' && notice !== null ? (notice as PgNoticeLike) : null;
  const message = typeof candidate?.message === 'string' ? candidate.message : String(notice);
  const severity = typeof candidate?.severity === 'string' ? candidate.severity : 'NOTICE';
  return `pg ${severity.toLowerCase()}: ${message}\n`;
}

/**
 * The `onnotice` option, with an injectable sink so the routing is testable
 * without opening a connection.
 */
export function pgNoticeOptions(write: (s: string) => void = (s) => void process.stderr.write(s)): {
  onnotice: (notice: unknown) => void;
} {
  return { onnotice: (notice: unknown) => write(formatPgNotice(notice)) };
}

/**
 * Open a pg client with substrate's standard options. Prefer this over calling
 * `postgres()` directly so NOTICE routing stays consistent across `serve`, the
 * admin CLI, `substrate federate`, and the migrate CLI.
 */
export function openSql(url: string): Sql {
  return postgres(url, pgNoticeOptions());
}
