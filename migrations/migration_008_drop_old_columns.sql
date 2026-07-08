-- SQL Migration: Drop obsolete columns customer_name_old and items_old from quotations table
ALTER TABLE quotations DROP COLUMN IF EXISTS customer_name_old;
ALTER TABLE quotations DROP COLUMN IF EXISTS items_old;
