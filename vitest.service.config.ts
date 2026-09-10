import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { readFileSync } from 'node:fs';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './app/worker.ts',
      remoteBindings: false,
      miniflare: {
        compatibilityDate: '2026-08-04',
        compatibilityFlags: ['nodejs_compat'],
        outboundService: () =>
          new Response('External network disabled in the synthetic suite.', { status: 503 }),
        d1Databases: ['TALEMBER_DB'],
        r2Buckets: ['TALEMBER_PRIVATE_MEDIA'],
        bindings: {
          TALEMBER_IMAGE_PROVIDER: 'fal',
          TALEMBER_CREATION_ENABLED: 'true',
          TALEMBER_PUBLIC_ORIGIN: 'https://talember.test',
          OPENROUTER_DIRECTOR_MODEL: 'openai/gpt-5.6-sol',
          OPENROUTER_API_KEY: 'synthetic-director-key',
          FAL_API_KEY: 'synthetic-fal-key',
          PAYPAL_SANDBOX_CLIENT_ID: 'synthetic-paypal-client',
          PAYPAL_SANDBOX_CLIENT_SECRET: 'synthetic-paypal-secret',
          PAYPAL_SANDBOX_ENVIRONMENT: 'sandbox',
          SYNTHETIC_VIDEO: readFileSync(
            new URL('./tests/service/synthetic-video.mp4', import.meta.url),
          ).toString('base64'),
          SYNTHETIC_VIDEO_LANDSCAPE: readFileSync(
            new URL('./tests/service/synthetic-video-landscape.mp4', import.meta.url),
          ).toString('base64'),
          SERVICE_SCHEMA: ['0032_creation_service.sql', '0033_creation_style.sql', '0034_creation_script_review.sql', '0035_creation_price.sql', '0036_creation_closing_wish.sql', '0038_payment_reconciliation.sql', '0039_provider_incidents.sql', '0040_animated_references.sql', '0041_greeting_overlay.sql', '0042_greeting_effect.sql', '0043_greeting_color.sql']
            .concat('0044_greeting_font.sql', '0045_greeting_celebration.sql', '0046_creation_price_1999.sql', '0047_overlay_layout.sql', '0048_overlay_elements.sql').map((name) => readFileSync(new URL(`./migrations/${name}`, import.meta.url), 'utf8'))
            .join('\n'),
        },
      },
    }),
  ],
  test: {
    include: ['tests/service/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
