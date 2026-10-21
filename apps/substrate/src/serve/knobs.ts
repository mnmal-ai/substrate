/**
 * serve/knobs.ts — knob provenance recording: each knob's effective value and
 * whether it came from the environment or the default.
 *
 * `record()` takes the raw string and the parsed value together, at the
 * point the parser holds both, so the provenance label cannot drift from the
 * value it labels.
 *
 * `nonEmpty` is the shared definition of "the operator set this":
 * docker-compose's `${VAR:-}` passes `""` for a blank .env line, which every
 * parser here treats as absent.
 */

import type { ConfigReport, KnobReport } from '@mnmal-ai/substrate-compose';

/** Treat explicitly-empty string env values as unset. */
export function nonEmpty(v: string | undefined): string | undefined {
  return v !== undefined && v !== '' ? v : undefined;
}

export interface KnobRecorder {
  /**
   * Record one knob and return its parsed value unchanged, so a parser can
   * wrap its own result inline rather than restating it.
   *
   * `raw` is the environment string as read — NOT the parsed value.
   */
  record<T extends KnobReport['value']>(
    key: string,
    env: string,
    raw: string | undefined,
    value: T
  ): T;
  /**
   * Record a knob whose value must never be echoed. Reports `'<set>'` or
   * `null` plus `redacted: true`, so presence stays answerable while the
   * secret does not travel to a log or over a route.
   */
  recordSecret(key: string, env: string, raw: string | undefined): void;
  report(): ConfigReport;
}

export function createKnobRecorder(): KnobRecorder {
  const entries = new Map<string, KnobReport>();
  const sourceOf = (raw: string | undefined): KnobReport['source'] =>
    nonEmpty(raw) === undefined ? 'default' : 'explicit';

  return {
    record(key, env, raw, value) {
      entries.set(key, { env, value, source: sourceOf(raw) });
      return value;
    },
    recordSecret(key, env, raw) {
      const present = nonEmpty(raw?.trim()) !== undefined;
      entries.set(key, {
        env,
        value: present ? '<set>' : null,
        source: sourceOf(raw),
        redacted: true
      });
    },
    report() {
      return Object.fromEntries(entries);
    }
  };
}
