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

export const RESERVED_AUTOCRUD_FIELDS: Record<string, FieldDef> = {
  shortId: field.number({ indexed: true, readonly: true })
};

/** Reserved field names — useful for validation loops. */
export const RESERVED_AUTOCRUD_FIELD_NAMES = Object.keys(RESERVED_AUTOCRUD_FIELDS);
