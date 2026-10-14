-- Not an undo: the values that were in price are gone with the column. This builds a
-- new price from price_vnd, so that v3 (writes price) can be deployed again. It cannot
-- bring back what price held before v2 rounded it to whole dong.
ALTER TABLE menu_items ADD COLUMN price REAL CHECK (price > 0);
UPDATE menu_items SET price = price_vnd / 1000.0;
