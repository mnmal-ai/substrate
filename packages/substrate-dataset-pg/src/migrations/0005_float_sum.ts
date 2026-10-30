/**
 * 0005_float_sum — `substrate_fsum(float8)`, a float8 sum that never raises.
 *
 * Todo #1809, shared with memory's applyAgg: a sum that overflows is NULL.
 * pg's own sum(float8) raises 22003 there, and avg(float8) raises even
 * sooner (its sum of squares overflows), so walk and frame sum/avg use this.
 * Each step adds in float8, as `sum` does, unless the add would overflow:
 * then the state turns NaN, which the final function reads as NULL. The add
 * is decided without computing it: operands of opposite sign, or both below
 * MAX/2, cannot overflow; otherwise MAX − a is exact (Sterbenz, a ≥ MAX/2), and
 * a + b rounds past MAX exactly when b ≥ (MAX − a) + 2^970, half an ulp of MAX.
 */
const MAX = `'${String(Number.MAX_VALUE)}'::pg_catalog.float8`;
const HALF_MAX = `'${String(Number.MAX_VALUE / 2)}'::pg_catalog.float8`;
const HALF_ULP = `'${String(2 ** 970)}'::pg_catalog.float8`;
const NAN = `'NaN'::pg_catalog.float8`;
const A = 'GREATEST(pg_catalog.abs(s), pg_catalog.abs(x))';
const B = 'LEAST(pg_catalog.abs(s), pg_catalog.abs(x))';

export const TX_STATEMENTS: ReadonlyArray<string> = [
  // Qualified names, so the caller's search_path cannot matter.
  `CREATE OR REPLACE FUNCTION substrate_fsum_step(s pg_catalog.float8, x pg_catalog.float8)
    RETURNS pg_catalog.float8 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT CASE
      WHEN s OPERATOR(pg_catalog.=) ${NAN} OR x OPERATOR(pg_catalog.=) ${NAN} THEN ${NAN}
      WHEN (s OPERATOR(pg_catalog.<) 0) OPERATOR(pg_catalog.<>) (x OPERATOR(pg_catalog.<) 0)
        THEN s OPERATOR(pg_catalog.+) x
      WHEN ${A} OPERATOR(pg_catalog.<) ${HALF_MAX} THEN s OPERATOR(pg_catalog.+) x
      -- OPERATOR() binds as one precedence level, left to right: parenthesise.
      WHEN ${B} OPERATOR(pg_catalog.<)
        ((${MAX} OPERATOR(pg_catalog.-) ${A}) OPERATOR(pg_catalog.+) ${HALF_ULP})
        THEN s OPERATOR(pg_catalog.+) x
      ELSE ${NAN}
    END $$`,

  `CREATE OR REPLACE FUNCTION substrate_fsum_final(s pg_catalog.float8)
    RETURNS pg_catalog.float8 LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $$ SELECT CASE WHEN s OPERATOR(pg_catalog.<>) ${NAN} THEN s END $$`,

  `CREATE OR REPLACE AGGREGATE substrate_fsum(pg_catalog.float8) (
    SFUNC = substrate_fsum_step,
    STYPE = pg_catalog.float8,
    FINALFUNC = substrate_fsum_final,
    COMBINEFUNC = substrate_fsum_step,
    PARALLEL = SAFE
  )`
];

export const CONCURRENT_STATEMENTS: ReadonlyArray<string> = [];
