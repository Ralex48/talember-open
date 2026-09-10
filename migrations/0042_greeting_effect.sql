ALTER TABLE creation_jobs ADD COLUMN greeting_effect TEXT NOT NULL DEFAULT 'none' CHECK(greeting_effect IN ('none','hearts','fireworks'));
