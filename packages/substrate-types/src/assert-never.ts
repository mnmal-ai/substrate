/**
 * Exhaustiveness guard for the `default:` arm of a `switch` over a
 * discriminated union. An unhandled variant makes the call fail to
 * type-check; at runtime it throws rather than returning `undefined`.
 */
export function assertNever(x: never): never {
  throw new Error(`unhandled variant: ${JSON.stringify(x)}`);
}
