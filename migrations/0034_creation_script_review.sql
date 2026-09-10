-- Existing directions and acknowledged requests remain unchanged. Unsent video
-- directions require review; this migration grants no approval or new request.
ALTER TABLE creation_jobs ADD COLUMN video_script TEXT
  CHECK (video_script IS NULL OR length(video_script) <= 12000);
ALTER TABLE creation_jobs ADD COLUMN video_script_revision INTEGER NOT NULL DEFAULT 0
  CHECK (video_script_revision >= 0);
ALTER TABLE creation_jobs ADD COLUMN video_script_source_key TEXT;
ALTER TABLE creation_jobs ADD COLUMN video_script_approved_at INTEGER;
ALTER TABLE creation_jobs ADD COLUMN video_script_approved_revision INTEGER;
