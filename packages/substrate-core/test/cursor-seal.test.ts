import { describe, expect, it, vi } from 'vitest';

describe('cursor seal key', () => {
  it('opens a cursor sealed by another process that shares the secret', async () => {
    const a = await import('../src/engine/cursor-seal.js');
    a.setCursorSealSecret('shared-deployment-secret');
    const sealed = a.sealCursor('row-42');

    vi.resetModules();
    const b = await import('../src/engine/cursor-seal.js');
    expect(b.openCursor(sealed)).toBeNull();
    b.setCursorSealSecret('shared-deployment-secret');
    expect(b.openCursor(sealed)).toBe('row-42');
  });
});
