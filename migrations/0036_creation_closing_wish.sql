-- Optional customer text for the end of the video. Existing content, scripts,
-- approvals, prices and provider identities remain unchanged.
ALTER TABLE creation_jobs ADD COLUMN closing_wish TEXT
  CHECK (closing_wish IS NULL OR length(closing_wish) BETWEEN 1 AND 80);
