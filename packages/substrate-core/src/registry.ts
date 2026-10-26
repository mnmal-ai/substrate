/**
 * Type registry. Spec: §4.2.
 *
 * One instance per namespace. Keyed by type name — either a class constructor
 * (we read `.name`) or an explicit string. Registration pairs a resolver with
 * an optional policy; absent policies default to `allowAll` so the evaluator
 * never needs a null check.
 */

import { getExtensionOperator } from '@mnmal-ai/substrate-filter';
import type {
  Policy,
  PolicyDecision,
  RegistryEntry,
  RegistryEntryInput,
  RegistryEntryKind,
  Registry as RegistryInterface,
  Resolver
} from '@mnmal-ai/substrate-types';
import { RegistryBase } from '@mnmal-ai/substrate-types';

// Re-exported, not redeclared: `Resolver` and the `RegistryEntry*` family are
// canonical in substrate-types, and a duplicate declaration could silently diverge.
export type { RegistryEntry, RegistryEntryInput, Resolver };
export type EntryKind = RegistryEntryKind;

export type TypeKey = string | { readonly name: string };

export class DuplicateRegistration extends Error {
  override readonly name = 'DuplicateRegistration';

  constructor(typeName: string) {
    super(`duplicate registration for type '${typeName}'`);
  }
}

export class UnknownType extends Error {
  override readonly name = 'UnknownType';

  constructor(typeName: string) {
    super(`unknown type '${typeName}' — register() first`);
  }
}

/**
 * A declared field named like a registered extension operator would be read as
 * the field by the validator and run as the operator by the datasets.
 */
export class FieldShadowsOperator extends Error {
  override readonly name = 'FieldShadowsOperator';

  constructor(typeName: string, field: string) {
    super(`type '${typeName}' declares field '${field}', which is a registered filter operator`);
  }
}

function assertNoOperatorField(name: string, input: RegistryEntryInput): void {
  for (const field of Object.keys(input.fields ?? {})) {
    if (getExtensionOperator(field) !== undefined) throw new FieldShadowsOperator(name, field);
  }
}

const defaultPolicy: Policy = (): PolicyDecision => ({ allow: true });

function keyOf(key: TypeKey): string {
  return typeof key === 'string' ? key : key.name;
}

export class Registry extends RegistryBase implements RegistryInterface {
  private readonly entries: Map<string, RegistryEntry> = new Map();

  protected performRegister(key: TypeKey, input: RegistryEntryInput): void {
    const name = keyOf(key);
    if (this.entries.has(name)) {
      throw new DuplicateRegistration(name);
    }
    assertNoOperatorField(name, input);
    const entry: RegistryEntry = {
      resolver: input.resolver,
      policy: input.policy ?? defaultPolicy,
      fields: input.fields ?? {},
      kind: input.kind ?? 'type',
      params: input.params ?? {}
    };
    if (input.returns !== undefined) entry.returns = input.returns;
    if (input.orderedBy !== undefined) entry.orderedBy = input.orderedBy;
    if (input.indexes !== undefined) entry.indexes = input.indexes;
    if (input.verb !== undefined) entry.verb = input.verb;
    this.entries.set(name, entry);
  }

  /**
   * Replace an existing entry atomically. Throws UnknownType when the entry is
   * not present — callers adding a new type should use register() instead.
   * Mirrors register()'s defaults for policy, kind, fields, params, returns.
   */
  protected performReplace(key: TypeKey, input: RegistryEntryInput): void {
    const name = keyOf(key);
    if (!this.entries.has(name)) {
      throw new UnknownType(name);
    }
    assertNoOperatorField(name, input);
    const entry: RegistryEntry = {
      resolver: input.resolver,
      policy: input.policy ?? defaultPolicy,
      fields: input.fields ?? {},
      kind: input.kind ?? 'type',
      params: input.params ?? {}
    };
    if (input.returns !== undefined) entry.returns = input.returns;
    if (input.orderedBy !== undefined) entry.orderedBy = input.orderedBy;
    if (input.indexes !== undefined) entry.indexes = input.indexes;
    if (input.verb !== undefined) entry.verb = input.verb;
    this.entries.set(name, entry);
  }

  protected override performUnregister(key: TypeKey): void {
    this.entries.delete(keyOf(key));
  }

  get(key: TypeKey): RegistryEntry | undefined {
    return this.entries.get(keyOf(key));
  }

  has(key: TypeKey): boolean {
    return this.entries.has(keyOf(key));
  }

  all(): IterableIterator<[string, RegistryEntry]> {
    return this.entries.entries();
  }
}
