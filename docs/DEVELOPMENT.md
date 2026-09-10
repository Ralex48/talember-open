# Development and tests

The service suite uses local D1/R2 equivalents and fake payment/creative providers.
Its default outbound handler refuses external network access. Tests cover the
creation journey, payment reconciliation, protected script approval, recovery,
media retention and manual placement. Passing them does not prove a real payment
or provider delivery.

`node scripts/preview-service.mjs --synthetic --horizontal` serves a simulated
landscape journey on localhost. Automated browser tests intercept the synthetic
PayPal redirect. The compositor requires its private service binding, so the local
preview is not a complete substitute for an independently configured renderer.

The Python container tests use generated color/sine-wave media, verify supported
scripts and effect separation, and check timing and unchanged audio. The Go tests
use an in-process HTTP server and exercise failed/stale health results. The Python
publication-audit test verifies safe reporting without exposing matched tokens.

Schema numbering starts at0032 because it belongs to the current service. The
retired0037 style migration is deliberately excluded. The remaining migrations
form the schema exercised by the service suite; local bootstrap is tested from an
empty database. Never treat this list as permission to replay migrations against
an unrelated production database.

The public repository begins with a clean snapshot. Production operational
history, private acceptance notes, account identifiers and customer examples were
excluded. Changes to public placeholders and safe deployment defaults are
intentional differences from a live instance.
