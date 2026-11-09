/**
 * Typed expressions for the read grammar: the JSON form, the type lattice, the
 * curated function catalogue and the size limits.
 *
 * An expression is a bare string (a field, or `_agg.<name>`), a number, boolean
 * or `null` literal, `{ lit: "text" }` (string literal), `{ int64: "<decimal>" }`
 * (exact int64 constant) or `{ <fn>: [args...] }` (a call, one key).
 */
export type Expr =
  | string
  | number
  | boolean
  | null
  | { lit: string }
  | { int64: string }
  | { [fn: string]: Expr[] };

export type ExprType = 'number' | 'int64' | 'string' | 'boolean' | 'date';

/**
 * An argument slot. `'any'` slots unify to one type (int64 and number compare
 * as number); `'unit'` is a `{ lit }` date unit and `'pattern'` a `{ lit }`
 * regex, both literal-only.
 */
export type ArgType = ExprType | 'any' | 'unit' | 'pattern';

export interface FunctionSig {
  name: string;
  /** Fixed argument slots, or `'variadic'` when the checker applies the function's own rules. */
  args: ArgType[] | 'variadic';
  /** `'any'` is the unified type of the `'any'` (and, for arithmetic, `'number'`) arguments. */
  returns: ExprType | 'any';
  description: string;
}

const sig = (
  name: string,
  args: ArgType[] | 'variadic',
  returns: ExprType | 'any',
  description: string
): FunctionSig => ({ name, args, returns, description });

const CMP = 'both sides the same type; int64 and number compare as number.';

export const EXPR_FUNCTIONS: readonly FunctionSig[] = [
  sig(
    'add',
    ['number', 'number'],
    'any',
    'Sum; int64 when both are int64 (or a safe-integer literal), else number.'
  ),
  sig('sub', ['number', 'number'], 'any', 'Difference; int64 when both are int64, else number.'),
  sig('mul', ['number', 'number'], 'any', 'Product; int64 when both are int64, else number.'),
  sig(
    'div',
    ['number', 'number'],
    'number',
    'Quotient as a number; null when the divisor is zero.'
  ),
  sig('mod', ['number', 'number'], 'any', 'Remainder; int64 when both are int64, else number.'),
  sig('neg', ['number'], 'any', 'Arithmetic negation; keeps int64.'),
  sig('eq', ['any', 'any'], 'boolean', `Equal; ${CMP}`),
  sig('neq', ['any', 'any'], 'boolean', `Not equal; ${CMP}`),
  sig('gt', ['any', 'any'], 'boolean', `Greater than; ${CMP}`),
  sig('gte', ['any', 'any'], 'boolean', `Greater than or equal; ${CMP}`),
  sig('lt', ['any', 'any'], 'boolean', `Less than; ${CMP}`),
  sig('lte', ['any', 'any'], 'boolean', `Less than or equal; ${CMP}`),
  sig('and', 'variadic', 'boolean', 'True when every boolean argument (one or more) is true.'),
  sig('or', 'variadic', 'boolean', 'True when any boolean argument (one or more) is true.'),
  sig('not', ['boolean'], 'boolean', 'Boolean negation.'),
  sig('isNull', ['any'], 'boolean', 'True when its one argument is null; any type.'),
  sig(
    'in',
    'variadic',
    'boolean',
    'True when the first argument equals any later one (two or more arguments share a type).'
  ),
  sig('length', ['string'], 'number', 'Length in characters.'),
  sig('lower', ['string'], 'string', 'Lower-cased text.'),
  sig('upper', ['string'], 'string', 'Upper-cased text.'),
  sig(
    'substring',
    ['string', 'number', 'number'],
    'string',
    'Substring from a 1-based start for a length.'
  ),
  sig('concat', 'variadic', 'string', 'Concatenation of one or more string arguments.'),
  sig(
    'like',
    ['string', 'string'],
    'boolean',
    'SQL LIKE, case-sensitive: % and _ wildcards, backslash escape.'
  ),
  sig('notLike', ['string', 'string'], 'boolean', 'Negated SQL LIKE, case-sensitive.'),
  sig(
    'regexpMatch',
    ['string', 'pattern'],
    'boolean',
    'True when the portable-subset regex (a lit) matches anywhere.'
  ),
  sig(
    'regexpReplace',
    ['string', 'pattern', 'string'],
    'string',
    'Replace the first regex (a lit) match; the replacement may use \\1 to \\9.'
  ),
  sig('dateTrunc', ['unit', 'date'], 'date', 'Truncate a date (UTC) to a unit given as a lit.'),
  sig('extract', ['unit', 'date'], 'number', 'A date part (UTC) as a number; the unit is a lit.'),
  sig('case', 'variadic', 'any', 'Pairs [cond, then] then a final else; branches share a type.'),
  sig('coalesce', 'variadic', 'any', 'First non-null of one or more arguments sharing a type.')
];

export const EXPR_LIMITS = { maxDepth: 16, maxNodesPerExpr: 64, maxNodesPerFrame: 1024 };

export const DATE_UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const;
