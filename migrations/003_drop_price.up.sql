-- Contract: drop price. THE POINT OF NO RETURN.
-- Run only when every instance runs v4, the first version that neither reads nor
-- writes price; v1–v3 fail on every request once it is gone. Take a backup first.
ALTER TABLE menu_items DROP COLUMN price;
