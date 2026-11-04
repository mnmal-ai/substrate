import { describe, expect, it } from 'vitest';
import { forEachWalkHop } from '../src/walk-hops.js';

describe('forEachWalkHop', () => {
  const entry = {
    params: {
      where: {
        OR: [{ _walk: { out: 'a', where: { _agg: { in: 'ns/B.a', count: true }, gt: 1 } } }]
      }
    },
    fields: {
      _agg: { n: { in: 'ns/C.x', count: true } },
      list: {
        _walk: { in: 'ns/D.x', where: { _walk: { out: 'e' } } },
        where: { _walk: { out: 'f' } },
        fields: { inner: { _walk: { out: 'g' } } }
      }
    }
  };

  it('visits every hop before the hops beneath it, with its kind, path and near type', () => {
    const seen: string[] = [];
    forEachWalkHop(entry, 'S', ({ kind, path }, near) => {
      seen.push(`${kind} ${near} ${path.join('.')}`);
      return `${near}>${path[path.length - 1]}`;
    });
    expect(seen).toEqual([
      'walk S where.OR.0._walk',
      'agg S>_walk where.OR.0._walk.where._agg',
      'agg S fields._agg.n',
      'nested S fields.list._walk',
      'walk S>_walk fields.list._walk.where._walk',
      'walk S>_walk fields.list.where._walk',
      'nested S>_walk fields.list.fields.inner._walk'
    ]);
  });

  it('does not descend below a hop the visitor resolves to undefined', () => {
    const seen: string[] = [];
    forEachWalkHop(entry, 'S', ({ path, selection }) => {
      seen.push(path.join('.'));
      return selection === undefined ? 'T' : undefined;
    });
    expect(seen).not.toContain('fields.list._walk.where._walk');
    expect(seen).not.toContain('fields.list.fields.inner._walk');
  });
});
