/**
 * The opt-in UUID-format CHECKs (`SUBSTRATE_ENFORCE_UUID_CHECK=true`) are one
 * gated migration after the tables baseline, recorded under the version the
 * old layouts used. A type table's own CHECK is `tables-dataset-parity`'s.
 */

import { describe, expect, it } from 'vitest';
import { getMigrationList } from '../src/migrate.js';
import { UUID_CHECK_MIGRATION } from '../src/uuid-check.js';

describe('the gated UUID-format CHECK migration', () => {
  it('default getMigrationList() (gate off) does not include it', () => {
    expect(getMigrationList(false).map((m) => m.version)).toEqual([
      '0001t_tables_baseline',
      '0003t_type_table_version',
      '0004t_field_error_version',
      '0005t_int64_field_kind',
      '0006t_int32_field_kind',
      '0007t_int16_field_kind',
      '0008t_short_ids_row_fk'
    ]);
  });

  it('getMigrationList(true) adds it after the baseline, before the catalog version, checking row_ids, short_ids and edges', () => {
    const list = getMigrationList(true);
    expect(list.map((m) => m.version)).toEqual([
      '0001t_tables_baseline',
      UUID_CHECK_MIGRATION,
      '0003t_type_table_version',
      '0004t_field_error_version',
      '0005t_int64_field_kind',
      '0006t_int32_field_kind',
      '0007t_int16_field_kind',
      '0008t_short_ids_row_fk'
    ]);
    const text = list[1]?.txStatements.join('\n') ?? '';
    for (const table of ['row_ids', 'short_ids', 'edges']) expect(text).toContain(table);
  });
});
