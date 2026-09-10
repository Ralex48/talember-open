-- The selected look is frozen with the customer's photos and story.
ALTER TABLE creation_jobs ADD COLUMN style TEXT NOT NULL DEFAULT 'cartoon'
  CHECK (style IN ('cartoon', 'realistic'));
-- Existing snapshots keep their original vertical offer; new drafts choose match.
ALTER TABLE creation_jobs ADD COLUMN video_format TEXT NOT NULL DEFAULT 'vertical'
  CHECK (video_format IN ('match', 'vertical', 'horizontal'));
ALTER TABLE creation_jobs ADD COLUMN video_ratio TEXT NOT NULL DEFAULT '9:16'
  CHECK (video_ratio IN ('21:9', '16:9', '4:3', '1:1', '3:4', '9:16'));
UPDATE creation_jobs SET video_format = 'match'
  WHERE phase = 'draft' AND snapshot_at IS NULL AND paid_at IS NULL;
