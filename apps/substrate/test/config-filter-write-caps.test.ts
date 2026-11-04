/**
 * `SUBSTRATE_FILTER_WRITE_MAX_MATCH` and `SUBSTRATE_FILTER_WRITE_IDS_CAP`: the
 * caps on `updateMany<T>` / `deleteMany<T>`, read at startup.
 */

import { describe, expect, it } from 'vitest';
import { EnvConfigError, parseEnv } from '../src/main.js';

describe('parseEnv: filter-write caps', () => {
  it('caps read from env, defaults 10000/1000, non-integer refused', () => {
    expect(parseEnv({}).filterWriteLimits).toEqual({ maxMatch: 10_000, idsCap: 1_000 });
    expect(parseEnv({}).knobs.filterWriteMaxMatch).toMatchObject({
      env: 'SUBSTRATE_FILTER_WRITE_MAX_MATCH',
      value: 10_000,
      source: 'default'
    });
    expect(
      parseEnv({
        SUBSTRATE_FILTER_WRITE_MAX_MATCH: '500',
        SUBSTRATE_FILTER_WRITE_IDS_CAP: '20'
      }).filterWriteLimits
    ).toEqual({ maxMatch: 500, idsCap: 20 });
    expect(
      parseEnv({ SUBSTRATE_FILTER_WRITE_IDS_CAP: '20' }).knobs.filterWriteIdsCap
    ).toMatchObject({ value: 20, source: 'explicit' });

    for (const bad of ['abc', '1.5', '0', '-3']) {
      expect(() => parseEnv({ SUBSTRATE_FILTER_WRITE_MAX_MATCH: bad })).toThrow(EnvConfigError);
      expect(() => parseEnv({ SUBSTRATE_FILTER_WRITE_IDS_CAP: bad })).toThrow(
        /SUBSTRATE_FILTER_WRITE_IDS_CAP/
      );
    }
  });
});
