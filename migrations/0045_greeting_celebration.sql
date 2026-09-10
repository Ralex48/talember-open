ALTER TABLE creation_jobs ADD COLUMN greeting_effect_next TEXT NOT NULL DEFAULT 'none' CHECK(greeting_effect_next IN ('none','hearts','fireworks','celebration'));
UPDATE creation_jobs SET greeting_effect_next = greeting_effect;
ALTER TABLE creation_jobs DROP COLUMN greeting_effect;
ALTER TABLE creation_jobs RENAME COLUMN greeting_effect_next TO greeting_effect;
