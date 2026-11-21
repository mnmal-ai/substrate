import { describe, expect, it } from 'vitest';
import { EnvConfigError, parseEnv } from '../src/main.js';

describe('parseEnv — act result TTL', () => {
  it('parses SUBSTRATE_ACT_RESULT_TTL_MS as a positive integer', () => {
    expect(parseEnv({ SUBSTRATE_ACT_RESULT_TTL_MS: '60000' }).act.resultTtlMs).toBe(60_000);
  });

  it('is null when unset', () => {
    expect(parseEnv({}).act.resultTtlMs).toBeNull();
  });

  it.each(['abc', '0', '-5', '1.5'])('rejects %s', (raw) => {
    const call = () => parseEnv({ SUBSTRATE_ACT_RESULT_TTL_MS: raw });
    expect(call).toThrow(EnvConfigError);
    expect(call).toThrow(
      `SUBSTRATE_ACT_RESULT_TTL_MS: invalid value '${raw}' — expected a positive integer (milliseconds)`
    );
  });
});
