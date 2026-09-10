# Greeting font assets

Unmodified TTF files downloaded from the official google/fonts repository on September 9, 2026. Each font's SIL Open Font License is retained beside it. Runtime rendering uses these local files, never a remote font service.

- Fredoka: https://github.com/google/fonts/tree/main/ofl/fredoka — Latin and Hebrew, no Cyrillic. Variable weight650, default width.
- Pacifico: https://github.com/google/fonts/tree/main/ofl/pacifico — Latin and Cyrillic, no Hebrew.
- Lobster: https://github.com/google/fonts/tree/main/ofl/lobster — Latin and Cyrillic, no Hebrew.
- Caveat: https://github.com/google/fonts/tree/main/ofl/caveat — Latin and Cyrillic, no Hebrew. Variable weight650.

Downloaded each family's non-Italic TTF and OFL.txt using the GitHub contents API. Coverage was checked against EN/ES/RU/HE letters and punctuation and representative renderings. Unsupported font/script combinations are rejected instead of silently substituted. Classic DejaVu remains the explicitly named mixed-script fallback.
