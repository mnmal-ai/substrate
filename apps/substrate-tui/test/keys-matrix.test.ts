import { capabilitiesFor, parseGrantEntries } from '@mnmal-ai/substrate/client';
import { describe, expect, it } from 'vitest';
import { compactGrant, rowGrant, toWire } from '../src/keys/grant.js';
import {
  addNamespace,
  cell,
  changed,
  move,
  openMatrix,
  result,
  toggle
} from '../src/keys/matrix.js';

const g = (ns: string, caps = 'read') => parseGrantEntries(ns.split(','), caps.split(','));

describe('toWire / rowGrant', () => {
  it('round-trips a mixed grant through the wire form', () => {
    const grant = g('journal:read+mutate,plane');
    const w = toWire(grant);
    expect(parseGrantEntries(w.namespaces, w.capabilities)).toEqual(grant);
  });
  it('toWire orders capabilities read, mutate, admin', () => {
    expect(toWire(g('journal', 'mutate,read')).capabilities).toEqual(['read', 'mutate']);
    expect(toWire(g('journal', 'zeta,admin,mutate,read,alpha')).capabilities).toEqual([
      'read',
      'mutate',
      'admin',
      'alpha',
      'zeta'
    ]);
  });
  it('compactGrant renders capabilities in canonical order', () => {
    expect(compactGrant('journal:mutate+read', 'read')).toBe('journal:r+m');
  });
  it('rowGrant is null for a stored grant that does not parse', () => {
    expect(rowGrant({ namespaces: 'journal:', capabilities: 'read' })).toBeNull();
  });
});

describe('matrix', () => {
  it('orders rows: * first, then the grant, then hosted-not-granted sorted', () => {
    const m = openMatrix(g('plane,*:read'), ['recall', 'journal', 'plane']);
    expect(m.rows).toEqual(['*', 'plane', 'journal', 'recall']);
  });
  it('toggle flips the cursor cell and marks the diff', () => {
    let m = openMatrix(g('journal'), ['journal', 'plane']);
    m = move(m, 1, 1); // plane, mutate
    m = toggle(m);
    expect(cell(m, 'plane', 'mutate')).toEqual({ held: 'on', diff: '+' });
    expect(changed(m)).toBe(true);
    m = toggle(m);
    expect(changed(m)).toBe(false);
  });
  it('clearing a row drops it from the result', () => {
    let m = openMatrix(g('journal,plane'), ['journal', 'plane']);
    m = move(m, 1, 0);
    m = toggle(m); // plane read off
    expect(cell(m, 'plane', 'read')).toEqual({ held: 'off', diff: '-' });
    expect([...result(m).keys()]).toEqual(['journal']);
  });
  it('a cell the * row covers reads as inherited, matching capabilitiesFor', () => {
    const m = openMatrix(g('*:read+mutate,plane:read'), ['journal', 'plane']);
    expect(cell(m, 'journal', 'mutate').held).toBe('inherited');
    // An explicit entry beats the wildcard: plane holds only read.
    expect(capabilitiesFor(result(m), 'plane').has('mutate')).toBe(false);
    expect(cell(m, 'plane', 'mutate').held).toBe('off');
  });
  it('move clamps to the grid', () => {
    const m = move(openMatrix(g('journal'), ['journal']), -5, 9);
    expect([m.row, m.col]).toEqual([0, 2]);
  });
  it('addNamespace appends a new row and moves the cursor to it; * goes first', () => {
    let m = addNamespace(openMatrix(g('journal'), ['journal']), 'review');
    expect(m.rows.at(-1)).toBe('review');
    expect(m.rows[m.row]).toBe('review');
    m = addNamespace(m, '*');
    expect(m.rows[0]).toBe('*');
    expect(m.row).toBe(0);
  });
  it('addNamespace of an existing row only moves the cursor', () => {
    const m = addNamespace(openMatrix(g('journal,plane'), ['journal', 'plane']), 'plane');
    expect(m.rows).toEqual(['journal', 'plane']);
    expect(m.row).toBe(1);
  });
});
