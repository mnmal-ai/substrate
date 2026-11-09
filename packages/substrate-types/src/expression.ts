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

export interface FunctionSig {
  name: string;
  /** Fixed argument types, or `'variadic'` when the checker applies the function's own rules. */
  args: ExprType[] | 'variadic';
  /** `'arg0'` is the first argument's type, widened to `number` when numeric arguments mix. */
  returns: ExprType | 'arg0';
  description: string;
}

const sig = (
  name: string,
  args: ExprType[] | 'variadic',
  returns: ExprType | 'arg0',
  description: string
): FunctionSig => ({ name, args, returns, description });

export const EXPR_FUNCTIONS: readonly FunctionSig[] = [
  sig(
    'add',
    ['number', 'number'],
    'arg0',
    'Sum of two numbers; int64 stays int64 when both are int64.'
  ),
  sig('sub', ['number', 'number'], 'arg0', 'Difference of two numbers.'),
  sig('mul', ['number', 'number'], 'arg0', 'Product of two numbers.'),
  sig(
    'div',
    ['number', 'number'],
    'number',
    'Quotient as a number; null when the divisor is zero.'
  ),
  sig('mod', ['number', 'number'], 'arg0', 'Remainder of the first number by the second.'),
  sig('neg', ['number'], 'arg0', 'Arithmetic negation.'),
  sig('eq', ['number', 'number'], 'boolean', 'Equal; both sides share a type (numbers mix).'),
  sig('neq', ['number', 'number'], 'boolean', 'Not equal; both sides share a type.'),
  sig('gt', ['number', 'number'], 'boolean', 'Greater than; both sides share a type.'),
  sig('gte', ['number', 'number'], 'boolean', 'Greater than or equal; both sides share a type.'),
  sig('lt', ['number', 'number'], 'boolean', 'Less than; both sides share a type.'),
  sig('lte', ['number', 'number'], 'boolean', 'Less than or equal; both sides share a type.'),
  sig('and', 'variadic', 'boolean', 'True when every boolean argument is true.'),
  sig('or', 'variadic', 'boolean', 'True when any boolean argument is true.'),
  sig('not', ['boolean'], 'boolean', 'Boolean negation.'),
  sig('isNull', 'variadic', 'boolean', 'True when its single argument is null.'),
  sig(
    'in',
    'variadic',
    'boolean',
    'True when the first argument equals any later argument; all share a type.'
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
  sig('concat', 'variadic', 'string', 'Concatenation of string arguments.'),
  sig(
    'like',
    ['string', 'string'],
    'boolean',
    'SQL LIKE, case-sensitive: % and _ wildcards, backslash escape.'
  ),
  sig('notLike', ['string', 'string'], 'boolean', 'Negated SQL LIKE, case-sensitive.'),
  sig(
    'regexpMatch',
    ['string', 'string'],
    'boolean',
    'True when the portable-subset regex (a literal) matches anywhere.'
  ),
  sig(
    'regexpReplace',
    ['string', 'string', 'string'],
    'string',
    'Replace the first regex (a literal) match; the replacement may use \\1 to \\9.'
  ),
  sig('dateTrunc', ['string', 'date'], 'date', 'Truncate a date (UTC) to a unit given as a lit.'),
  sig('extract', ['string', 'date'], 'number', 'A date part (UTC) as a number; the unit is a lit.'),
  sig('case', 'variadic', 'arg0', 'Pairs [cond, then] then a final else; branches share a type.'),
  sig('coalesce', 'variadic', 'arg0', 'First non-null argument; all share a type.')
];

export const EXPR_LIMITS = { maxDepth: 16, maxNodesPerExpr: 64, maxNodesPerFrame: 1024 };

export const DATE_UNITS = ['second', 'minute', 'hour', 'day', 'week', 'month', 'year'] as const;
