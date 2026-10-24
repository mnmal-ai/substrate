/**
 * 0003_safe_casts — IMMUTABLE jsonb → numeric / timestamptz casts that return
 * NULL on a wrong-shaped value instead of raising, so they can back index
 * expressions and filters over untyped body fields.
 *
 * substrate_ts is IMMUTABLE because the accepted shape requires an explicit
 * offset (TimeZone cannot matter) and is ISO (DateStyle cannot matter).
 */
const TS_SHAPE = String.raw`^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}(:?\d{2})?)$`;

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `CREATE OR REPLACE FUNCTION substrate_num(v jsonb) RETURNS numeric
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT CASE WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric END $$`,

  `CREATE OR REPLACE FUNCTION substrate_ts(v jsonb) RETURNS timestamptz
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT CASE WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '${TS_SHAPE}'
      THEN (v #>> '{}')::timestamptz END $$`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];
