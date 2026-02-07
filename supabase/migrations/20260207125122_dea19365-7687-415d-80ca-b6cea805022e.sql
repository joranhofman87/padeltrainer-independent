
ALTER TABLE invoices ADD COLUMN player_business_name text;

ALTER TABLE profiles ADD COLUMN billing_business_name text;
ALTER TABLE profiles ADD COLUMN billing_address text;
ALTER TABLE profiles ADD COLUMN billing_btw_number text;
