import { describe, expect, it } from 'vitest';
import { parseWalkRef } from '../src/qualified-key.js';

describe('parseWalkRef', () => {
  it('splits <ns>/<Type>.<field>', () => {
    expect(parseWalkRef('app/Order.customer')).toEqual({
      ns: 'app',
      type: 'Order',
      field: 'customer'
    });
  });

  it('keeps everything after the first dot as the field', () => {
    expect(parseWalkRef('app/Order.meta.owner')?.field).toBe('meta.owner');
  });

  it('returns null when a part is missing', () => {
    for (const ref of [
      '',
      'Order.customer',
      '/Order.customer',
      'app/.customer',
      'app/Order',
      'app/Order.',
      'app/a/Order.customer'
    ])
      expect(parseWalkRef(ref), ref).toBeNull();
  });
});
