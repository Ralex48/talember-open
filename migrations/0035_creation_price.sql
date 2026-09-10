-- Keep every existing draft, admitted order and paid creation at its original
-- price. New application-created drafts explicitly store 14.99 at creation.
ALTER TABLE creation_jobs ADD COLUMN amount TEXT NOT NULL DEFAULT '9.99'
  CHECK (amount IN ('9.99', '14.99'));

-- Preserve all receipt data and uniqueness/currency constraints while permitting
-- the new price.
CREATE TABLE creation_payments_next (
  job_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  capture_id TEXT NOT NULL UNIQUE,
  payee_id TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (amount IN ('9.99', '14.99')),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  captured_at INTEGER NOT NULL
);
INSERT INTO creation_payments_next (job_id, order_id, capture_id, payee_id, amount, currency, captured_at)
  SELECT job_id, order_id, capture_id, payee_id, amount, currency, captured_at FROM creation_payments;
DROP TABLE creation_payments;
ALTER TABLE creation_payments_next RENAME TO creation_payments;
