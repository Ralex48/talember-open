CREATE TABLE creation_provider_incidents (
  job_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'fal'),
  detected_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  resolved_at INTEGER,
  notified_at INTEGER,
  next_notify_at INTEGER NOT NULL DEFAULT 0
);
