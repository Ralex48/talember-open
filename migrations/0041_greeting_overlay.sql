-- Existing submitted/approved orders keep their original rendering contract.
ALTER TABLE creation_jobs ADD COLUMN overlay_version INTEGER NOT NULL DEFAULT 0 CHECK (overlay_version IN (0,1));
ALTER TABLE creation_jobs ADD COLUMN raw_video_key TEXT;
