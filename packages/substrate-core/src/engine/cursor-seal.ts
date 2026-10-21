/**
 * Seals a pagination cursor so its contents cannot be read.
 *
 * A dataset cursor names the last row of the page it read, before row-filter
 * policies ran. Under a row policy that row may be one the caller cannot see,
 * so the engine seals the cursor and opens it again on the way back in.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const PREFIX = 's1.';
// shortcut: without a configured secret the key is per process, so a sealed cursor dies with a restart and does not open on a peer process.
let KEY: Buffer = randomBytes(32);

/** Derives the seal key from a deployment secret, so every process sharing it opens the same cursors. */
export function setCursorSealSecret(secret: string): void {
  KEY = Buffer.from(hkdfSync('sha256', secret, '', 'substrate-cursor-seal', 32));
}

export function sealCursor(cursor: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(cursor, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function isSealedCursor(cursor: string): boolean {
  return cursor.startsWith(PREFIX);
}

/** The original cursor, the input itself when it was never sealed, or `null` when it does not open. */
export function openCursor(cursor: string): string | null {
  if (!cursor.startsWith(PREFIX)) return cursor;
  const raw = Buffer.from(cursor.slice(PREFIX.length), 'base64url');
  if (raw.length < 28) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
