/**
 * 0005t_int64_field_kind — `int64` joins the field kinds the type catalog
 * accepts (a `bigint` column).
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  'ALTER TABLE substrate_type_fields DROP CONSTRAINT IF EXISTS substrate_type_fields_kind_check',
  `ALTER TABLE substrate_type_fields ADD CONSTRAINT substrate_type_fields_kind_check
     CHECK (kind IN ('text','enum','number','int64','date','boolean','crossRef'))`
];
