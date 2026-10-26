import type { StoreProfileName } from '@mnmal-ai/substrate-compose';

export interface SizingAnswers {
  rowsPerDay: number;
  retentionDays: number;
  readTargetMs: number;
  writeHeavy: boolean;
}

/** What an unanswered question assumes: a small personal store. */
export const DEFAULT_SIZING: SizingAnswers = {
  rowsPerDay: 1000,
  retentionDays: 365,
  readTargetMs: 250,
  writeHeavy: false
};

/** The profile for the expected row count; `writeHeavy` never changes the name. */
export function profileFromAnswers(a: SizingAnswers): StoreProfileName {
  const rows = a.rowsPerDay * a.retentionDays;
  if (rows >= 50_000_000 || (a.readTargetMs <= 50 && rows >= 5_000_000)) return 'scale';
  if (rows >= 1_000_000) return 'growth';
  return 'personal';
}

/** A sizing flag or answer: a positive finite number. */
export function parsePositive(flag: string, value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n <= 0) {
    throw new Error(`--${flag} must be a positive number, got: ${value}`);
  }
  return n;
}
