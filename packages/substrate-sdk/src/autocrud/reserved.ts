/**
 * Reserved engine-injected fields for autoCRUD types.
 *
 * `defineNamespace` and any external caller that builds type registrations
 * dynamically (e.g. substrate-proposals' `applyTypeProposal` /
 * `applyFieldProposal`) MUST spread these descriptors into the type's field
 * map so autoCRUD's create resolver sees the readonly+indexed shape and
 * allocates accordingly. A private copy of these descriptors would drift
 * silently when the injection changes.
 *
 * Single source of truth: this module. Add a new reserved field here and
 * both `defineNamespace` and `applyTypeProposal` pick it up automatically.
 */

import type { FieldDef } from '@mnmal-ai/substrate-types';
import { field } from '../field.js';

/** A registered symbol, so a second copy of this SDK in one process marks the same way. */
const RESERVED = Symbol.for('@mnmal-ai/substrate-sdk:autocrud-reserved');

/** `def`, marked as autoCRUD's own. Non-enumerable, so equality and JSON ignore it. */
const reserved = (def: FieldDef): FieldDef => Object.defineProperty(def, RESERVED, { value: true });

export const RESERVED_AUTOCRUD_FIELDS: Record<string, FieldDef> = {
  shortId: reserved(field.number({ indexed: true, readonly: true }))
};

/** Is `def` a descriptor autoCRUD injected, rather than a body field of the same name? */
export function isReservedAutoCrudField(def: FieldDef): boolean {
  return (def as unknown as Record<symbol, unknown>)[RESERVED] === true;
}

/** The server metadata names a body field may not take: expressions, where and orderBy read them as metadata. */
export const RESERVED_METADATA_FIELD_NAMES: readonly string[] = [
  'createdAt',
  'updatedAt',
  'seq',
  'createdBy',
  'updatedBy',
  'createdById',
  'createdByKind',
  'updatedById',
  'updatedByKind'
];

/** Why a field of this name cannot be declared, or undefined when it can. */
export function reservedMetadataFieldMessage(name: string): string | undefined {
  return RESERVED_METADATA_FIELD_NAMES.includes(name)
    ? `\`${name}\` is a reserved field name: it is reserved for server metadata`
    : undefined;
}

/** Reserved field names — useful for validation loops. */
export const RESERVED_AUTOCRUD_FIELD_NAMES = Object.keys(RESERVED_AUTOCRUD_FIELDS);
