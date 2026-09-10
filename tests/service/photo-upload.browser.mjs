import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

// One focused browser regression. It uses the real rendered form, shipped client,
// canvas codec and server photo validator. Checkout is an explicit local 503;
// there are no payment/provider bindings and all other network access is blocked.
test('large camera photos are prepared without losing the originals or form fields', async () => {
  const load = async (entry) => {
    const built = await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', write: false });
    return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString('base64')}`);
  };
  const [{ page: render, panel: renderPanel }, { photo: validatePhoto }] = await Promise.all([load('app/page.ts'), load('app/media.ts')]);
  const client = await readFile('public/scripts/service.js');
  const style = await readFile('public/styles/service.css');
  const uploads = [];
  const blocked = [];
  let origin;
  let scriptJob;
  const previewEnv = { TALEMBER_CREATION_ENABLED: 'true', PAYPAL_SANDBOX_ENVIRONMENT: 'sandbox',
    PAYPAL_SANDBOX_CLIENT_ID: 'synthetic', PAYPAL_SANDBOX_CLIENT_SECRET: 'synthetic',
    FAL_API_KEY: 'synthetic', OPENROUTER_API_KEY: 'synthetic', OPENROUTER_DIRECTOR_MODEL: 'synthetic' };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, origin);
    if (req.method === 'GET' && url.pathname === '/create' && url.searchParams.has('script')) {
      scriptJob = { id: 'synthetic-script', phase: 'video_directed', locale: 'en', csrf: 'a'.repeat(64),
        payment_environment: 'sandbox', video_script: 'Synthetic saved script with a gentle camera movement.',
        video_script_revision: 1, video_script_approved_at: null, video_request_id: null };
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(render(scriptJob, { ...previewEnv, TALEMBER_PUBLIC_ORIGIN: origin })); return;
    }
    if (req.method === 'POST' && url.pathname === '/create/script') {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const data = await new Request(origin, { method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: Buffer.concat(chunks) }).formData();
      scriptJob.video_script = data.get('script'); scriptJob.video_script_revision++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Synthetic response failed after save.' })); return;
    }
    if (req.method === 'GET' && url.pathname === '/create') {
      const language = ['ru', 'es', 'he'].includes(url.searchParams.get('lang')) ? url.searchParams.get('lang') : 'en';
      const html = render({ id: 'synthetic-upload', phase: 'draft', amount: '14.99', csrf: 'a'.repeat(64), locale: language }, {
        TALEMBER_CREATION_ENABLED: 'true', TALEMBER_PUBLIC_ORIGIN: origin,
        PAYPAL_SANDBOX_ENVIRONMENT: 'sandbox', PAYPAL_SANDBOX_CLIENT_ID: 'synthetic',
        PAYPAL_SANDBOX_CLIENT_SECRET: 'synthetic', FAL_API_KEY: 'synthetic',
        OPENROUTER_API_KEY: 'synthetic', OPENROUTER_DIRECTOR_MODEL: 'openai/gpt-5.6-sol',
      });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    if (req.method === 'GET' && url.pathname === '/scripts/service.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(client); return;
    }
    if (req.method === 'GET' && url.pathname === '/styles/service.css') {
      res.writeHead(200, { 'Content-Type': 'text/css' }); res.end(style); return;
    }
    if (req.method === 'GET' && url.pathname === '/api/job' && url.searchParams.get('inspect') === '1') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(scriptJob ? { phase: 'script_review', html: renderPanel(scriptJob, previewEnv),
        scriptRevision: scriptJob.video_script_revision, approval: null } : { phase: 'draft', html: '', approval: null })); return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/assets/brand/')) {
      res.writeHead(204); res.end(); return;
    }
    if (req.method === 'POST' && url.pathname === '/create/checkout') {
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length; assert(size < 11 * 1024 * 1024); chunks.push(chunk);
      }
      const form = await new Request(origin, {
        method: 'POST', headers: { 'Content-Type': req.headers['content-type'] }, body: Buffer.concat(chunks),
      }).formData();
      const files = form.getAll('photos');
      const validated = [];
      for (const file of files) validated.push(await validatePhoto(file));
      uploads.push({ form, files, validated });
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Synthetic checkout is unavailable. Your photos and story are still here.' })); return;
    }
    blocked.push(`${req.method} ${url.pathname}`); res.writeHead(503); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === origin) await route.continue();
      else { blocked.push(route.request().url()); await route.abort(); }
    });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/create`);
    const selected = await page.evaluate(async () => {
      const canvas = document.createElement('canvas'); canvas.width = 6754; canvas.height = 5269;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#cd392c'; ctx.fillRect(0, 0, canvas.width / 2, canvas.height);
      ctx.fillStyle = '#2873be'; ctx.fillRect(canvas.width / 2, 0, canvas.width / 2, canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
      canvas.width = 0; canvas.height = 0;
      // Valid EXIF orientation6 turns this landscape source into a portrait.
      const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0]);
      // Legal JPEG comment segments model a >19MB camera file without committing
      // a huge fixture or transferring any actual customer photograph.
      const comment = new Uint8Array(65537); comment.set([255,254,255,255]);
      const source = new Blob([jpeg.slice(0,2), exif, ...Array(300).fill(comment), jpeg.slice(2)], { type: 'image/jpeg' });
      const transfer = new DataTransfer();
      for (let n = 0; n < 4; n++) transfer.items.add(new File([source], `camera-${n + 1}.jpg`, { type: 'image/jpeg' }));
      const input = document.querySelector('#photos'); input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const status = document.querySelector('.submit-status'); window.uploadStatuses = [];
      new MutationObserver(() => window.uploadStatuses.push(status.textContent)).observe(status, { childList: true });
      return { size: source.size, width: 6754, height: 5269, names: [...input.files].map(file => file.name) };
    });
    assert(selected.size > 19_284_470); assert(selected.width * selected.height > 24_000_000);
    await page.locator('#cast').fill('Photo 1: Anna left. Photo 2: Max. Photo 3: Milo. Photo 4: Anna and Max.');
    await page.locator('#story').fill('Anna and Max walk with Milo beside the sea at sunset.');
    await page.locator('#participants').selectOption('3'); await page.locator('[name=consent]').check();
    const before = await page.locator('form').first().evaluate(form => Object.fromEntries(
      [...new FormData(form)].filter(([name]) => name !== 'photos'),
    ));
    await page.locator('.offer button[type=submit]').click();
    await page.waitForFunction(() => document.querySelector('.submit-error')?.textContent.includes('Check the saved status'), undefined, { timeout: 60_000 });
    assert.equal(uploads.length, 1); const upload = uploads[0];
    assert.equal(upload.files.length, 4); assert.equal(upload.validated.length, 4);
    let total = 0;
    for (const file of upload.files) {
      assert.equal(file.type, 'image/jpeg'); assert(file.size <= 2 * 1024 * 1024); total += file.size;
      const result = await page.evaluate(async (base64) => {
        const file = new Blob([Uint8Array.from(atob(base64), x => x.charCodeAt(0))], { type: 'image/jpeg' });
        const image = await createImageBitmap(file); const canvas = document.createElement('canvas');
        canvas.width = image.width; canvas.height = image.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0); image.close();
        return { width: canvas.width, height: canvas.height, top: [...ctx.getImageData(20,20,1,1).data], bottom: [...ctx.getImageData(20,canvas.height-20,1,1).data] };
      }, Buffer.from(await file.arrayBuffer()).toString('base64'));
      assert.equal(result.height, 2048); assert(Math.abs(result.width / result.height - 5269 / 6754) < 0.001);
      assert(result.top[0] > result.top[2]); assert(result.bottom[2] > result.bottom[0]);
    }
    assert(total < 10 * 1024 * 1024);
    for (const [name, value] of Object.entries(before)) assert.equal(upload.form.get(name), value);
    const preserved = await page.locator('#photos').evaluate(input => [...input.files].map(file => ({ name: file.name, size: file.size })));
    assert.deepEqual(preserved.map(file => file.name), selected.names);
    assert(preserved.every(file => file.size === selected.size));
    assert.equal(await page.locator('#story').inputValue(), before.story);
    assert.equal(await page.locator('#cast').inputValue(), before.cast);
    assert(await page.locator('.offer button[type=submit]').isEnabled());
    assert(await page.locator('#notice').isHidden());
    assert(await page.locator('.submit-error').isVisible());
    const [button, status] = await Promise.all([page.locator('.offer button').boundingBox(), page.locator('.submit-error').boundingBox()]);
    assert(status.y >= button.y + button.height); assert(status.y - button.y - button.height < 35);
    const messages = await page.evaluate(() => window.uploadStatuses);
    assert(messages.some(message => message.includes('Preparing photo 1 of 4')));
    assert(messages.some(message => message.includes('Preparing photo 4 of 4')));
    // An ambiguous failure blocks repeat submission until a read-only check.
    await page.locator('.offer button[type=submit]').click();
    assert.equal(uploads.length, 1);
    await page.getByRole('button', { name: 'Check saved status', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.submit-status')?.textContent.includes('saved status was checked'));
    assert.equal(await page.locator('#story').inputValue(), before.story);
    const dialog = page.waitForEvent('dialog');
    const navigation = page.getByRole('link', { name: 'RU', exact: true }).click();
    const warning = await dialog;
    assert.equal(warning.type(), 'confirm'); assert(warning.message().includes('unsaved'));
    await warning.dismiss(); await navigation;
    assert.equal(await page.locator('#story').inputValue(), before.story);
    // Real invalid input fails beside the button, keeps the fields, and sends no POST.
    for (const [language, expected] of [['en','Photo 1'],['ru','фото 1'],['es','la foto 1'],['he','תמונה 1']]) {
      await page.goto(`${origin}/create?lang=${language}`);
      await page.locator('#photos').setInputFiles({ name: 'broken.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('not-an-image') });
      await page.locator('#cast').fill('Anna in photo 1.'); await page.locator('#story').fill('Anna walks beside the sea.');
      await page.locator('[name=consent]').check(); await page.locator('.offer button').click();
      await page.waitForFunction(() => !!document.querySelector('.submit-error'));
      assert((await page.locator('.submit-error').textContent()).includes(expected));
      assert.equal(await page.locator('#story').inputValue(), 'Anna walks beside the sea.');
    }
    assert.equal(uploads.length, 1); assert.deepEqual(blocked, []); assert.deepEqual(errors, []);
    await page.goto(`${origin}/create?script=1`);
    const script = 'My synthetic edited script remains visible after the response is lost.';
    await page.locator('#video-script').fill(script);
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await page.getByRole('button', { name: 'Check saved status', exact: true }).waitFor();
    assert.equal(await page.locator('#video-script').inputValue(), script);
    await page.getByRole('button', { name: 'Check saved status', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('input[name=revision]')?.value === '2');
    assert.equal(await page.locator('#video-script').inputValue(), script);
    assert.equal(scriptJob.video_script_revision, 2);
    assert.deepEqual(errors, []);
    console.log(`Prepared four ${selected.size}-byte, 35.6MP oriented JPEGs into ${total} upload bytes; original selections and form fields preserved.`);
  } finally { await browser.close(); server.close(); await once(server, 'close'); }
});
