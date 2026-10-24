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

  `CREATE OR REPLACE FUNCTION substrate_ts(v jsonb) RETURNS timestamptz
    LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE SET search_path = pg_catalog
    AS $$
    BEGIN
      IF jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '${TS_SHAPE}' THEN
        RETURN (v #>> '{}')::timestamptz;
      END IF;
      RETURN NULL;
    EXCEPTION WHEN others THEN
      -- shape-valid but out of range (month 13, Feb 30)
      RETURN NULL;
    END $$`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];
