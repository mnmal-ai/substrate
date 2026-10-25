/**
 * 0003_safe_casts — IMMUTABLE jsonb → numeric / timestamptz casts that return
 * NULL on a wrong-shaped value instead of raising, so they can back index
 * expressions and filters over untyped body fields.
 *
 * substrate_ts reads the ISO grammar of substrate-types' `normalizeIsoTimestamp`
 * (same groups: date, HH:MM, seconds, first 6 fraction digits, offset). It is
 * IMMUTABLE because the text is rebuilt with an explicit offset before the
 * cast (TimeZone cannot matter) and is ISO (DateStyle cannot matter).
 */
const TS_SHAPE = String.raw`^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:[T ]((?:[01][0-9]|2[0-3]):[0-5][0-9])(?::([0-5][0-9])(?:\.([0-9]{1,6})[0-9]{0,3})?)?)?(Z|[+-](?:0[0-9]|1[0-5])(?::?[0-5][0-9])?)?$`;

export const TX_STATEMENTS: ReadonlyArray<string> = [
  // Qualified names, no SET and no STRICT: inlinable, and immune to the caller's search_path.
  `CREATE OR REPLACE FUNCTION substrate_num(v jsonb) RETURNS pg_catalog.numeric
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT CASE
      WHEN pg_catalog.jsonb_typeof(v) OPERATOR(pg_catalog.=) 'number'
      THEN (v OPERATOR(pg_catalog.#>>) '{}')::pg_catalog.numeric
    END $$`,

  // pg_input_is_valid rejects shape-valid but out-of-range values (month 13,
  // Feb 30) without raising. An EXCEPTION block would need a subtransaction,
  // which a parallel plan cannot start, so it would turn valid values to NULL.
  // Never inlined: timestamptz input and pg_input_is_valid are STABLE.
  `CREATE OR REPLACE FUNCTION substrate_ts(v jsonb) RETURNS pg_catalog.timestamptz
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$ SELECT CASE
      WHEN pg_catalog.pg_input_is_valid(t, 'pg_catalog.timestamptz') THEN t::pg_catalog.timestamptz
    END
    FROM (
      -- No offset is UTC; a date alone is its midnight UTC; fraction digits past 6 are dropped.
      SELECT m[1] OPERATOR(pg_catalog.||) 'T'
        OPERATOR(pg_catalog.||) COALESCE(m[2], '00:00') OPERATOR(pg_catalog.||) ':'
        OPERATOR(pg_catalog.||) COALESCE(m[3], '00')
        OPERATOR(pg_catalog.||) COALESCE('.' OPERATOR(pg_catalog.||) m[4], '')
        OPERATOR(pg_catalog.||) COALESCE(m[5], 'Z') AS t
      FROM pg_catalog.regexp_match(
        CASE WHEN pg_catalog.jsonb_typeof(v) OPERATOR(pg_catalog.=) 'string'
          THEN v OPERATOR(pg_catalog.#>>) '{}' END,
        '${TS_SHAPE}') AS m
    ) AS n $$`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];
