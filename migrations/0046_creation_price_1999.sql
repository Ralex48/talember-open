-- Expand accepted prices without repricing existing drafts, orders or receipts.
ALTER TABLE creation_jobs ADD COLUMN amount_next TEXT NOT NULL DEFAULT '19.99' CHECK(amount_next IN ('9.99','14.99','19.99'));
UPDATE creation_jobs SET amount_next = amount;
ALTER TABLE creation_jobs DROP COLUMN amount;
ALTER TABLE creation_jobs RENAME COLUMN amount_next TO amount;
ALTER TABLE creation_payments ADD COLUMN amount_next TEXT NOT NULL DEFAULT '19.99' CHECK(amount_next IN ('9.99','14.99','19.99'));
UPDATE creation_payments SET amount_next = amount;
ALTER TABLE creation_payments DROP COLUMN amount;
ALTER TABLE creation_payments RENAME COLUMN amount_next TO amount;
ALTER TABLE creation_payment_attempts ADD COLUMN amount_next TEXT NOT NULL DEFAULT '19.99' CHECK(amount_next IN ('9.99','14.99','19.99'));
UPDATE creation_payment_attempts SET amount_next = amount;
ALTER TABLE creation_payment_attempts DROP COLUMN amount;
ALTER TABLE creation_payment_attempts RENAME COLUMN amount_next TO amount;
