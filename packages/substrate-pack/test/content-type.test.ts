import { describe, expect, it } from 'vitest';
import { acceptsPack, PACK_MIME } from '../src/content-type.js';

describe('acceptsPack', () => {
  it('returns false for undefined / empty / wildcard / json', () => {
    expect(acceptsPack(undefined)).toBe(false);
    expect(acceptsPack('')).toBe(false);
    expect(acceptsPack('*/*')).toBe(false);
    expect(acceptsPack('application/json')).toBe(false);
  });

  it('returns true for exact substrate-pack mime', () => {
    expect(acceptsPack(PACK_MIME)).toBe(true);
  });

  it('returns true when substrate-pack has params (q-value, etc.)', () => {
    expect(acceptsPack('application/vnd.substrate.pack; q=1.0')).toBe(true);
    expect(acceptsPack('application/vnd.substrate.pack;q=1.0')).toBe(true);
  });

  it('returns true when substrate-pack is one clause in a multi-mime Accept', () => {
    expect(acceptsPack('application/json, application/vnd.substrate.pack')).toBe(true);
    expect(acceptsPack('application/vnd.substrate.pack, */*')).toBe(true);
  });

  it('does not substring-match the mime', () => {
    expect(acceptsPack('application/vnd.substrate.pack+special')).toBe(false);
    expect(acceptsPack('application/vnd.substrate.packaged')).toBe(false);
  });
});
