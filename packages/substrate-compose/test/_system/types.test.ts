import { describe, expect, it } from 'vitest';
import { AUDIT_EVENT_KINDS, type AuditEventKind } from '../../src/_system/types.js';

describe('AUDIT_EVENT_KINDS', () => {
  it('includes namespace_dropped', () => {
    expect(AUDIT_EVENT_KINDS.has('namespace_dropped')).toBe(true);
  });
  it('includes type_dropped', () => {
    expect(AUDIT_EVENT_KINDS.has('type_dropped')).toBe(true);
  });
  it('includes destructive_op_refused', () => {
    expect(AUDIT_EVENT_KINDS.has('destructive_op_refused')).toBe(true);
  });
  it('union and Set stay in parity for destructive_op_refused', () => {
    // Compile-time check: the literal must satisfy the type.
    const k: AuditEventKind = 'destructive_op_refused';
    expect(AUDIT_EVENT_KINDS.has(k)).toBe(true);
  });
});
