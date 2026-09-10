// Local UI preview only. No credentials or external network calls are available.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';

const root = resolve(import.meta.dirname, '..');
const synthetic = process.argv.includes('--synthetic');
const horizontal = process.argv.includes('--horizontal');
const port = synthetic ? 8789 : 0;
const fixture = synthetic ? (await import('../tests/service/provider-fixture.ts')).createProviderFixture({
  video: new Uint8Array(await readFile(resolve(root, `tests/service/synthetic-video${horizontal ? '-landscape' : ''}.mp4`))),
  imageSize: horizontal ? { width: 1280, height: 720 } : undefined,
  autoApprove: true,
}) : null;
const [worker, client] = await Promise.all([
  build({ absWorkingDir: root, entryPoints: ['app/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' }),
  build({ absWorkingDir: root, entryPoints: ['app/client.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', target: 'es2022' }),
]);
const mf = new Miniflare({
  modules: true,
  script: worker.outputFiles[0].text,
  compatibilityDate: '2026-08-04',
  compatibilityFlags: ['nodejs_compat'],
  port,
  d1Databases: ['TALEMBER_DB'],
  r2Buckets: ['TALEMBER_PRIVATE_MEDIA'],
  bindings: {
    TALEMBER_IMAGE_PROVIDER: 'fal',
    TALEMBER_CREATION_ENABLED: synthetic ? 'true' : 'false',
    TALEMBER_PUBLIC_ORIGIN: synthetic ? `http://127.0.0.1:${port}` : 'http://localhost',
    OPENROUTER_DIRECTOR_MODEL: 'openai/gpt-5.6-sol',
    ...(synthetic ? { OPENROUTER_API_KEY: 'synthetic-only', FAL_API_KEY: 'synthetic-fal-key',
      PAYPAL_SANDBOX_CLIENT_ID: 'synthetic-only', PAYPAL_SANDBOX_CLIENT_SECRET: 'synthetic-only',
      PAYPAL_SANDBOX_ENVIRONMENT: 'sandbox' } : {}),
  },
  outboundService: async request => {
    if (process.env.TALEMBER_PREVIEW_DEBUG === '1') console.log('Synthetic outbound', request.method, new URL(request.url).origin);
    if (!fixture) throw new Error('External network is disabled in this preview.');
    try {
      // Miniflare reconstructs this request across an HTTP loopback and drops
      // fetch redirect mode. The Worker suite checks that mode before transport;
      // this UI preview supplies the fixture's mode without enabling real fetches.
      return await fixture.fetch(request.url, { method: request.method, headers: Object.fromEntries(request.headers), redirect: 'manual',
        ...(['GET','HEAD'].includes(request.method) ? {} : { body: await request.arrayBuffer() }) });
    } catch (error) {
      if (process.env.TALEMBER_PREVIEW_DEBUG === '1') console.log('Synthetic provider assertion:', error.message);
      throw error;
    }
  },
  serviceBindings: {
    ASSETS: async request => {
      const path = new URL(request.url).pathname;
      if (path === '/scripts/service.js') return new Response(client.outputFiles[0].text, { headers: { 'Content-Type': 'text/javascript' } });
      const allowed = new Map([
        ['/styles/service.css', 'text/css'],
        ['/assets/styles/cartoon-v1.svg', 'image/jpeg'],
        ['/assets/styles/realism-v1.svg', 'image/jpeg'],
        ['/assets/brand/favicon.svg', 'image/png'],
        ['/assets/brand/logo.svg', 'image/png'],
        ['/assets/preview/demo.mp4', 'video/mp4'],
        ['/assets/preview/placeholder.svg', 'image/jpeg'],
      ]);
      if (!allowed.has(path)) return new Response('Not found', { status: 404 });
      return new Response(await readFile(resolve(root, 'public' + path)), { headers: { 'Content-Type': allowed.get(path) } });
    },
  },
});
if (process.env.TALEMBER_PREVIEW_DEBUG === '1') console.log('Starting local storage');
const db = await mf.getD1Database('TALEMBER_DB');
if (process.env.TALEMBER_PREVIEW_DEBUG === '1') console.log('Local storage ready');
const schema = (await Promise.all(['0032_creation_service.sql', '0033_creation_style.sql', '0034_creation_script_review.sql', '0035_creation_price.sql', '0036_creation_closing_wish.sql', '0038_payment_reconciliation.sql', '0039_provider_incidents.sql', '0040_animated_references.sql', '0041_greeting_overlay.sql', '0042_greeting_effect.sql', '0043_greeting_color.sql']
  .concat('0044_greeting_font.sql', '0045_greeting_celebration.sql', '0046_creation_price_1999.sql', '0047_overlay_layout.sql', '0048_overlay_elements.sql').map(name => readFile(resolve(root, 'migrations', name), 'utf8')))).join('\n');
for (const statement of schema.replace(/^--.*$/gm, '').split(';').map(s => s.trim()).filter(Boolean)) await db.prepare(statement).run();
if (process.env.TALEMBER_PREVIEW_DEBUG === '1') console.log('Local schema ready');
const url = await mf.ready;
console.log(`Local preview: ${url}create (${synthetic ? 'simulated providers' : 'checkout disabled'}; external network blocked)`);
async function stop() { if (fixture) console.log(JSON.stringify(fixture.counts)); await mf.dispose(); process.exit(0); }
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
