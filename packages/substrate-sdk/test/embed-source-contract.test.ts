/**
 * Compile-time contract between the two declarations of `embed.source`.
 *
 * The signature is written out twice on purpose: `TypeInput` here, and
 * `NamespaceTypeDef` in @mnmal-ai/substrate-types, which redeclares it
 * structurally to avoid a substrate-types → substrate-sdk import cycle.
 *
 * The assertions below fail `tsc` (not vitest) if the two drift.
 */

import type { NamespaceTypeDef } from '@mnmal-ai/substrate-types';
import { describe, expect, it } from 'vitest';
import type { TypeInput } from '../src/namespace.js';

/**
 * Pull the `source` signature out of a NAMED slot of either declaration.
 */
type SlotSourceOf<T, K extends PropertyKey> =
  NonNullable<T extends Record<K, infer E | undefined> ? E : never> extends {
    source: infer S;
  }
    ? S
    : never;

/** Invariant (not merely bivariant) type equality — catches one-way widening. */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/**
 * The load-bearing line. If `TypeInput.embed.source` and
 * `NamespaceTypeDef.embed.source` stop being the same type, this stops being
 * assignable to `true` and the build breaks here rather than in a consumer.
 */
const embedSourceSignaturesAgree: Equals<
  SlotSourceOf<TypeInput, 'embed'>,
  SlotSourceOf<NamespaceTypeDef, 'embed'>
> = true;

/**
 * Same assertion for `lexical`. Listed here rather than inferred, because
 * `NamespaceTypeDef` carries `[key: string]: unknown` to absorb slots it does
 * not name — which makes "what named slots exist" UNASKABLE at the type level.
 * A keys-based diff would silently agree with everything.
 *
 * So this map is the register of slots under contract, and adding a slot to
 * either declaration means adding a line here (`slot-registry-contract.test.ts`
 * catches a missing line).
 */
const lexicalSourceSignaturesAgree: Equals<
  SlotSourceOf<TypeInput, 'lexical'>,
  SlotSourceOf<NamespaceTypeDef, 'lexical'>
> = true;

/** The sentinel must reach the SDK surface for lexical too, not just embed. */
const lexicalNullSentinelIsAccepted: TypeInput['lexical'] = {
  source: (row) => (row.recallVisible === false ? null : (row.body as string))
};

/** The sentinel must be expressible through the SDK surface, not just substrate-types. */
const nullSentinelIsAccepted: TypeInput['embed'] = {
  source: (row) => (row.recallVisible === false ? null : (row.synopsis as string))
};

/** `''` stays a legal return — it embeds, and is deliberately not the sentinel. */
const emptyStringIsStillAccepted: TypeInput['embed'] = {
  source: () => ''
};

describe('slot declaration contract', () => {
  it('keeps TypeInput and NamespaceTypeDef in agreement for lexical (enforced by tsc)', () => {
    expect(lexicalSourceSignaturesAgree).toBe(true);
    expect(lexicalNullSentinelIsAccepted?.source({ id: 'r1', recallVisible: false })).toBeNull();
  });

  it('keeps TypeInput and NamespaceTypeDef in agreement (enforced by tsc)', () => {
    expect(embedSourceSignaturesAgree).toBe(true);
  });

  it('accepts the null sentinel and empty string through the SDK surface', () => {
    expect(nullSentinelIsAccepted?.source({ id: 'r1', recallVisible: false })).toBeNull();
    expect(emptyStringIsStillAccepted?.source({ id: 'r2' })).toBe('');
  });
});
