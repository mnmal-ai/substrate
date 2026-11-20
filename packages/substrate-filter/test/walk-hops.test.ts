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
    forEachWalkHop(entry, { ns: 'x', type: 'S' }, ({ kind, path }, near) => {
      seen.push(`${kind} ${near.type} ${path.join('.')}`);
      return { ns: 'x', type: `${near.type}>${path[path.length - 1]}` };
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
    forEachWalkHop(entry, { ns: 'x', type: 'S' }, ({ path, selection }) => {
      seen.push(path.join('.'));
      return selection === undefined ? { ns: 'x', type: 'T' } : undefined;
    });
    expect(seen).not.toContain('fields.list._walk.where._walk');
    expect(seen).not.toContain('fields.list.fields.inner._walk');
  });

  it('gives an in hop its written namespace', () => {
    let ns: string | undefined;
    forEachWalkHop(
      { params: { where: { _walk: { in: 'app/Invoice.customer' } } } },
      { ns: 'ext', type: 'Payment' },
      (hop) => {
        ns = hop.ns;
        return undefined;
      }
    );
    expect(ns).toBe('app');
  });

  it('passes the visitor result as the next near side', () => {
    const next = { ns: 'app', type: 'Invoice' };
    const nears: unknown[] = [];
    forEachWalkHop(
      { params: { where: { _walk: { out: 'a', where: { _walk: { out: 'b' } } } } } },
      { ns: 'ext', type: 'Payment' },
      (_hop, near) => {
        nears.push(near);
        return next;
      }
    );
    expect(nears[1]).toEqual(next);
  });
});
