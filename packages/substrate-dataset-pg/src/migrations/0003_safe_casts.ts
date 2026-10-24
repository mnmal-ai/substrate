/**
 * 0003_safe_casts — IMMUTABLE jsonb → numeric / timestamptz casts that return
 * NULL on a wrong-shaped value instead of raising, so they can back index
 * expressions and filters over untyped body fields.
 *
 * substrate_ts is IMMUTABLE because the accepted shape requires an explicit
 * offset (TimeZone cannot matter) and is ISO (DateStyle cannot matter).
 */
const TS_SHAPE = String.raw`^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$`;

export const TX_STATEMENTS: ReadonlyArray<string> = [
  `CREATE OR REPLACE FUNCTION substrate_num(v jsonb) RETURNS numeric
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
    AS $$ SELECT CASE WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric END $$`,

  // pg_input_is_valid rejects shape-valid but out-of-range values (month 13,
  // Feb 30) without raising. An EXCEPTION block would need a subtransaction,
  // which a parallel plan cannot start, so it would turn valid values to NULL.
  `CREATE OR REPLACE FUNCTION substrate_ts(v jsonb) RETURNS timestamptz
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
    AS $$ SELECT CASE
      WHEN jsonb_typeof(v) = 'string'
        AND (v #>> '{}') ~ '${TS_SHAPE}'
        AND pg_input_is_valid(v #>> '{}', 'timestamptz')
      THEN (v #>> '{}')::timestamptz
    END $$`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];
