-- Existing drafts, orders and receipts retain their sandbox identity and price.
ALTER TABLE creation_jobs ADD COLUMN payment_environment TEXT NOT NULL DEFAULT 'sandbox'
  CHECK (payment_environment IN ('sandbox', 'live'));
ALTER TABLE creation_payments ADD COLUMN payment_environment TEXT NOT NULL DEFAULT 'sandbox'
  CHECK (payment_environment IN ('sandbox', 'live'));

-- Deliberately independent of creative-content and session lifetime. No customer
-- content, credentials, approval URLs or media references belong here.
CREATE TABLE creation_payment_attempts (
  job_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  payee_id TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (amount IN ('9.99', '14.99')),
  payment_environment TEXT NOT NULL CHECK (payment_environment IN ('sandbox', 'live')),
  capture_started_at INTEGER,
  capture_id TEXT UNIQUE,
  next_at INTEGER NOT NULL,
  checked_at INTEGER,
  issue TEXT,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX creation_payment_attempts_due ON creation_payment_attempts(next_at, lease_until);
INSERT INTO creation_payment_attempts
  (job_id, order_id, payee_id, amount, payment_environment, capture_started_at, capture_id, next_at)
  SELECT id, order_id, payee_id, amount, payment_environment, capture_started_at, capture_id, updated_at
  FROM creation_jobs WHERE order_id IS NOT NULL AND payee_id IS NOT NULL;
