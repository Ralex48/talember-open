ALTER TABLE creation_jobs ADD COLUMN greeting_font TEXT NOT NULL DEFAULT 'classic' CHECK(greeting_font IN ('classic','fredoka','pacifico','lobster','caveat'));
