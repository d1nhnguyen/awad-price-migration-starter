-- Only while every instance runs v1: v2 and later prepare statements on price_vnd
-- when they start, and fail on every write once it is gone.
ALTER TABLE menu_items DROP COLUMN price_vnd;
