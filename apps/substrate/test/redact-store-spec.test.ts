/**
 * Guards `redactStoreSpec` — the helper that scrubs the password from
 * SUBSTRATE_DATABASE_URL before it lands in stdout / journald at boot.
 * The unit file and `Environment=` rendering are root-readable; stdout is not
 * gated, so the boot log must never carry the literal password.
 */
import { describe, expect, it } from 'vitest';
import { redactStoreSpec } from '../src/main.js';

describe('redactStoreSpec', () => {
  it('redacts the password from a postgres:// URL', () => {
    expect(redactStoreSpec('postgres://substrate:secret123@localhost:5432/substrate_prod')).toBe(
      'postgres://substrate:<redacted>@localhost:5432/substrate_prod'
    );
  });

  it('redacts the password from a postgresql:// URL', () => {
    expect(redactStoreSpec('postgresql://substrate:secret@host:5433/db')).toBe(
      'postgresql://substrate:<redacted>@host:5433/db'
    );
  });

  it('preserves the user component and everything after the @', () => {
    expect(redactStoreSpec('postgres://operator:longp4ss@10.0.0.5:5432/substrate')).toBe(
      'postgres://operator:<redacted>@10.0.0.5:5432/substrate'
    );
  });

  it('handles passwords containing special characters via the lazy [^@]* match', () => {
    // `:` and `/` inside the password are common; the regex stops at the
    // first `@` so it only consumes the password section.
    expect(redactStoreSpec('postgres://substrate:p:a/s+s@host/db')).toBe(
      'postgres://substrate:<redacted>@host/db'
    );
  });

  it('passes "memory" through unchanged', () => {
    expect(redactStoreSpec('memory')).toBe('memory');
  });

  it('passes any non-URL value through unchanged (no false positives)', () => {
    expect(redactStoreSpec('some-other-value')).toBe('some-other-value');
    expect(redactStoreSpec('')).toBe('');
  });

  it('does not match a URL that has no user:password component', () => {
    // `postgres://host/db` has no `user:password@` segment; the regex
    // should leave it untouched rather than producing a malformed string.
    expect(redactStoreSpec('postgres://host/db')).toBe('postgres://host/db');
  });
});
