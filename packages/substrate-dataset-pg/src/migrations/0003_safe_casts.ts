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
      WHEN pg_catalog.jsonb_typeof(v) OPERATOR(pg_catalog.=) 'string'
        AND (v OPERATOR(pg_catalog.#>>) '{}') OPERATOR(pg_catalog.~) '${TS_SHAPE}'
        AND pg_catalog.pg_input_is_valid(v OPERATOR(pg_catalog.#>>) '{}', 'pg_catalog.timestamptz')
      THEN (v OPERATOR(pg_catalog.#>>) '{}')::pg_catalog.timestamptz
    END $$`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];
