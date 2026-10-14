-- Expand: price_vnd (dong, an integer) next to price (thousands of dong, a float).
-- Nullable with no default, so this changes the schema only and no row is rewritten.
-- v1 keeps running on it: every statement v1 runs names its columns.
-- The CHECK makes the database refuse a float or a non-positive price, whoever writes it.
ALTER TABLE menu_items ADD COLUMN price_vnd INTEGER
  CHECK (price_vnd IS NULL OR (typeof(price_vnd) = 'integer' AND price_vnd > 0));
