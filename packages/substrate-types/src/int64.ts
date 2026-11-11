const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
const MIN_INT32 = -(2 ** 31);
const MAX_INT32 = 2 ** 31 - 1;
const CANONICAL_INT = /^-?(0|[1-9]\d*)$/;

/**
 * An `int64` operand or write value as a bigint: a bigint, a safe-integer
 * number, or a canonical decimal string, within the int64 range. Anything else
 * (a float, a number past 2^53, `'007'`, `'1e3'`, an out-of-range value) is
 * `undefined`.
 */
export function parseInt64(v: unknown): bigint | undefined {
  let n: bigint;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) return undefined;
    n = BigInt(v);
  } else if (typeof v === 'string' && CANONICAL_INT.test(v)) n = BigInt(v);
  else return undefined;
  return n >= MIN_INT64 && n <= MAX_INT64 ? n : undefined;
}

/** Whether `v` is an `int32` value: an integer number within the int32 range. */
export function isInt32(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) >= MIN_INT32 && (v as number) <= MAX_INT32;
}

/**
 * `JSON.stringify` that writes a bigint as a decimal string, so an `int64`
 * keeps every digit on the JSON wire. The plain call runs first, so a value
 * with no bigint pays nothing for the replacer.
 */
export function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (e) {
    if (!(e instanceof TypeError) || !/BigInt/.test(e.message)) throw e;
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
}

/**
 * Like {@link stringifyJson}, but a bigint is written as an exact JSON number
 * (`9223372036854775807`, not a string), for a jsonb body that `substrate_num`
 * reads back as the number it is.
 */
export function stringifyJsonExact(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch (e) {
    if (!(e instanceof TypeError) || !/BigInt/.test(e.message)) throw e;
    const raw = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;
    return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? raw(v.toString()) : v));
  }
}
