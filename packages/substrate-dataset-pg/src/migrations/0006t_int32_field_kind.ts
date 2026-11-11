/**
 * 0006t_int32_field_kind — `int32` joins the field kinds the type catalog
 * accepts (an `integer` column).
 */

export const TX_STATEMENTS: ReadonlyArray<string> = [
  'ALTER TABLE substrate_type_fields DROP CONSTRAINT IF EXISTS substrate_type_fields_kind_check',
  `ALTER TABLE substrate_type_fields ADD CONSTRAINT substrate_type_fields_kind_check
     CHECK (kind IN ('text','enum','number','int32','int64','date','boolean','crossRef'))`
];
