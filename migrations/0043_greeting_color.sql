ALTER TABLE creation_jobs ADD COLUMN greeting_color TEXT NOT NULL DEFAULT 'white' CHECK(greeting_color IN ('white','gold','pink','multicolor'));
