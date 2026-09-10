import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  env,
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../../app/worker';
import { continuity } from '../../app/continuity';
import { proposedScript } from '../../app/script';
import { getJob, newJob, progress, recover } from '../../app/jobs';
import { createOrder, inspectOrder } from '../../app/paypal';
import { deliverAlerts } from '../../app/alerts';
import { diagnosticKey, preserveFailure, preserveResponse } from '../../app/diagnostics';
import { copy } from '../../app/i18n';
import { mp4, png, photo as readPhoto, videoRatio } from '../../app/media';
import { result as falResult, submissionBody, characterBody, videoBody } from '../../app/fal';
import { CLOTHING_PROMPT, IMAGE_PROMPTS } from '../../app/image-prompts';
import { direct } from '../../app/director';
import { home as renderHome } from '../../app/page';
import type { Job, ServiceEnv } from '../../app/types';
import { createProviderFixture } from './provider-fixture';

const bindings = env as ServiceEnv & { SYNTHETIC_VIDEO: string; SYNTHETIC_VIDEO_LANDSCAPE: string; SERVICE_SCHEMA: string };
const verticalVideo = Uint8Array.from(atob(bindings.SYNTHETIC_VIDEO), (c) => c.charCodeAt(0));
const video = Uint8Array.from(atob(bindings.SYNTHETIC_VIDEO_LANDSCAPE), (c) => c.charCodeAt(0));
let clock = Date.now();
let provider: ReturnType<typeof createProviderFixture>;
let cookie = '';
let csrf = '';
let id = '';

function visionInput(body: Record<string, unknown>, image: Uint8Array): Record<string, unknown> {
  const messages = body.messages as { content: unknown }[];
  const content = messages[1]!.content as [{ type: string; text: string }, { type: string; image_url: { url: string } }];
  expect(content.length).toBeGreaterThanOrEqual(2);
  expect(content[0].type).toBe('text');
  expect(content[1].type).toBe('image_url');
  expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,/);
  expect(Uint8Array.from(atob(content[1].image_url.url.split(',')[1]!), c => c.charCodeAt(0))).toEqual(image);
  expect(body.max_tokens).toBe(2000);
  expect(body.provider).toEqual({ allow_fallbacks: false, data_collection: 'deny', require_parameters: true });
  return JSON.parse(content[0].text);
}

async function request(
  path: string,
  data?: FormData,
  override: Record<string, string> = {},
): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`https://talember.test${path}`, {
      method: data ? 'POST' : 'GET',
      headers: {
        Accept: data || path === '/api/job' ? 'application/json' : 'text/html',
        Cookie: cookie,
        ...(data ? { Origin: 'https://talember.test' } : {}),
        ...override,
      },
      ...(data ? { body: data } : {}),
    }),
    bindings,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
function form(fields: Record<string, string> = {}): FormData {
  const data = new FormData();
  data.set('csrf', csrf);
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}
async function start(): Promise<void> {
  const response = await request('/create');
  expect(response.status).toBe(200);
  cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  csrf = /name="csrf" value="([a-f0-9]+)"/.exec(await response.text())![1]!;
  const job = await bindings.TALEMBER_DB.prepare('SELECT id FROM creation_jobs WHERE csrf = ?')
    .bind(csrf)
    .first<{ id: string }>();
  id = job!.id;
}
function checkout(style = 'cartoon', videoFormat = 'match', closingWish?: string): FormData {
  const data = form({
    style,
    video_format: videoFormat,
    story: 'Anna and Max walk with their dog Milo beside the sea at sunset.',
    cast: 'Photo 1: Anna. Photo 2: Max. Photo 3: Milo the dog. Photo 4: Anna and Max together.',
    participants: '3',
    consent: 'yes',
  });
  if (closingWish !== undefined) data.set('closing_wish', closingWish);
  for (let i = 0; i < 4; i++)
    data.append(
      'photos',
      new File([provider.initial], `synthetic-${i}.png`, { type: 'image/png' }),
    );
  return data;
}
async function tick(): Promise<Job> {
  clock += 6_000;
  const response = await request('/api/job');
  expect(response.status).toBe(200);
  await response.arrayBuffer();
  return getJob(bindings, id);
}
async function until(phase: string): Promise<Job> {
  for (let n = 0; n < 30; n++) {
    const job = await getJob(bindings, id);
    if (job.phase === phase) return job;
    if (job.phase === 'attention') throw new Error(`Unexpected attention: ${job.issue}`);
    await tick();
  }
  throw new Error(`Did not reach ${phase}`);
}
async function paidScene(style = 'cartoon', videoFormat = 'match', story?: string, closingWish?: string): Promise<Job> {
  await start();
  const data = checkout(style, videoFormat, closingWish);
  if (story) data.set('story', story);
  expect((await request('/create/checkout', data)).status).toBe(200);
  provider.approve();
  const job = await getJob(bindings, id);
  expect((await request(`/create?payment=return&token=${job.order_id}`)).status).toBe(303);
  return until('selected');
}
async function proposal(): Promise<Job> {
  let job = await until('video_directed');
  if (job.video_script === null) job = await tick();
  expect(job.video_script).toBeTruthy();
  expect(job.video_script_approved_at).toBeNull();
  return job;
}
function scriptForm(job: Job, intent = 'approve', script = job.video_script!): FormData {
  return form({ intent, script, revision: String(job.video_script_revision) });
}
async function approveVideo(): Promise<Job> {
  const draft = await proposal();
  expect((await request('/create/script', scriptForm(draft))).status).toBe(200);
  return getJob(bindings, id);
}
beforeAll(async () => {
  const statements = bindings.SERVICE_SCHEMA.replace(/^--.*$/gm, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  await bindings.TALEMBER_DB.batch(statements.map((sql) => bindings.TALEMBER_DB.prepare(sql)));
});
beforeEach(async () => {
  await bindings.TALEMBER_DB.batch([
    bindings.TALEMBER_DB.prepare('DELETE FROM creation_jobs'),
    bindings.TALEMBER_DB.prepare('DELETE FROM creation_payments'),
    bindings.TALEMBER_DB.prepare('DELETE FROM creation_payment_attempts'),
    bindings.TALEMBER_DB.prepare('DELETE FROM creation_provider_incidents'),
  ]);
  clock = 1_820_400_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  provider = createProviderFixture({
    video,
    verticalVideo,
    imageSize: { width: 1280, height: 720 },
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
  });
  vi.stubGlobal('fetch', provider.fetch);
  cookie = '';
  csrf = '';
  id = '';
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fresh creation service — actual Worker, D1 and private R2', () => {
  it('waits after an explicit unfunded rejection and resumes the approved video without another payment', async () => {
    await paidScene();
    const draft = await proposal();
    let locked = true;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (locked && req.url === 'https://queue.fal.run/bytedance/seedance-2.0/reference-to-video') {
        await req.body?.cancel();
        return Response.json({ detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing' }, { status: 403 });
      }
      return provider.fetch(req);
    });
    await request('/create/script', scriptForm(draft));
    await tick();
    const waiting = await getJob(bindings, id);
    expect(waiting).toMatchObject({ phase: 'video_directed', issue: 'provider_balance', video_request_id: null });
    expect(waiting.video_script_approved_at).not.toBeNull();
    expect(provider.counts.videoSubmits).toBe(0);
    const state = await (await request('/api/job')).json() as { phase: string; html: string };
    expect(state.phase).toBe('provider_wait');
    expect(state.html).toContain('You do not need to pay or submit again');
    const send = vi.fn().mockRejectedValueOnce(new Error('Synthetic mail outage')).mockResolvedValue({ messageId: 'synthetic-message' });
    const alertEnv = { ...bindings, TALEMBER_ALERT_EMAIL: { send }, TALEMBER_ALERT_FROM: 'ops@example.test', TALEMBER_ALERT_TO: 'owner@example.test' };
    await deliverAlerts(alertEnv);
    await deliverAlerts(alertEnv);
    expect(send).toHaveBeenCalledTimes(1);
    expect(await bindings.TALEMBER_DB.prepare('SELECT notified_at FROM creation_provider_incidents WHERE job_id=?').bind(id).first('notified_at')).toBeNull();
    clock += 5 * 60_000;
    await deliverAlerts(alertEnv);
    await deliverAlerts(alertEnv);
    expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(send.mock.calls)).not.toContain(id);
    locked = false;
    clock += 5 * 60_000;
    await recover(bindings);
    await until('complete');
    expect(provider.counts).toMatchObject({ capturePosts: 1, videoSubmits: 1 });
    expect((await getJob(bindings, id)).issue).toBeNull();
    expect(await bindings.TALEMBER_DB.prepare('SELECT resolved_at FROM creation_provider_incidents WHERE job_id=?').bind(id).first('resolved_at')).not.toBeNull();
  });
  it('retains an accepted video identity through a balance-related status outage', async () => {
    await paidScene();
    await approveVideo();
    provider.queueNextRequest();
    const submitted = await until('video_generating');
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes('/status?logs=0') && req.url.includes('seedance-2.0'))
        return Response.json({ detail: 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing.' }, { status: 403 });
      return provider.fetch(req);
    });
    const waiting = await tick();
    expect(waiting).toMatchObject({ phase: 'video_generating', issue: 'provider_balance', video_request_id: submitted.video_request_id });
    vi.stubGlobal('fetch', provider.fetch);
    clock += 5 * 60_000;
    await recover(bindings);
    await until('complete');
    expect(provider.counts).toMatchObject({ capturePosts: 1, videoSubmits: 1 });
  });
  it('never repeats an uncertain character-reference purchase', async () => {
    await paidScene();
    const before = provider.counts.imageSubmits;
    provider.loseNextSubmission();
    const stopped = await tick();
    expect(stopped).toMatchObject({ phase: 'attention', issue: 'submission_unknown' });
    expect(JSON.parse(stopped.references_json!)[0]).toHaveProperty('started');
    expect(provider.counts.imageSubmits).toBe(before + 1);
    await tick(); await recover(bindings);
    expect(provider.counts.imageSubmits).toBe(before + 1);
    expect(provider.counts.videoSubmits).toBe(0);
  });
  it('holds an owner-requested first-image preview before any later creative call', async () => {
    await start();
    await request('/create/checkout', checkout());
    await bindings.TALEMBER_DB.prepare('UPDATE creation_jobs SET references_json = ? WHERE id = ?')
      .bind(JSON.stringify([{ photo: 2, reviewFirst: true }]), id).run();
    provider.approve();
    const job = await getJob(bindings, id);
    await request(`/create?payment=return&token=${job.order_id}`);
    const held = await until('attention');
    expect(held).toMatchObject({ issue: 'owner_preview', selected: 'original', video_request_id: null });
    expect(held.original_key).toBeTruthy();
    expect(provider.counts.imageSubmits).toBe(1);
    const calls = provider.counts;
    await tick(); await recover(bindings);
    expect(provider.counts).toEqual(calls);
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase = 'selected', issue = NULL, next_at = 0, references_json = ? WHERE id = ?")
      .bind(JSON.stringify([{ photo: 2, reviewAfter: true }]), id).run();
    const second = await until('attention');
    expect(second.issue).toBe('owner_preview');
    expect(second.original_key).toBe(held.original_key);
    expect(JSON.parse(second.references_json!)[0].key).toBeTruthy();
    expect(provider.counts.imageSubmits).toBe(2);
    const secondCalls = provider.counts;
    await tick(); await recover(bindings);
    expect(provider.counts).toEqual(secondCalls);
  });
  it('stops rather than buying another style analysis after a lost response', async () => {
    await paidScene();
    // Existing worklists from the retired text-analysis mode remain recoverable.
    await bindings.TALEMBER_DB.prepare('UPDATE creation_jobs SET references_json = ? WHERE id = ?')
      .bind(JSON.stringify([{ photo: 2, styleRequired: true }]), id).run();
    const before = provider.counts;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.url.includes('openrouter.ai')) throw new Error('Synthetic lost style response');
      return provider.fetch(req);
    });
    expect(await tick()).toMatchObject({ phase: 'attention', issue: 'submission_unknown' });
    vi.stubGlobal('fetch', provider.fetch);
    await tick(); await recover(bindings);
    expect(provider.counts).toEqual(before);
  });
  it('keeps an interrupted successful capture reconcilable after content expiry without another charge or creative call', async () => {
    await start();
    await request('/create/checkout', checkout());
    const initial = await getJob(bindings, id);
    provider.approve();
    provider.loseNextCaptureResponse();
    clock = initial.expires_at - 1000;
    await request(`/create?payment=return&token=${initial.order_id}`);
    await request('/api/job');
    expect(provider.counts.capturePosts).toBe(1);
    expect((await getJob(bindings, id)).capture_id).toBeNull();
    const attempt = await bindings.TALEMBER_DB.prepare('SELECT * FROM creation_payment_attempts WHERE job_id = ?').bind(id).first();
    expect(attempt).toMatchObject({ order_id: initial.order_id, amount: '19.99', payment_environment: 'sandbox' });
    expect(attempt!.capture_started_at).toBeTruthy();
    clock = initial.expires_at + 60_000;
    await recover(bindings);
    expect(await bindings.TALEMBER_DB.prepare('SELECT id FROM creation_jobs WHERE id = ?').bind(id).first()).toBeNull();
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(`creation/${id}/photo-1`)).toBeNull();
    expect(await bindings.TALEMBER_DB.prepare('SELECT * FROM creation_payments WHERE job_id = ?').bind(id).first())
      .toMatchObject({ order_id: initial.order_id, capture_id: `CAP${initial.order_id}`, amount: '19.99', payment_environment: 'sandbox' });
    expect(await bindings.TALEMBER_DB.prepare('SELECT issue FROM creation_payment_attempts WHERE job_id = ?').bind(id).first('issue'))
      .toBe('captured_content_expired');
    await recover(bindings);
    expect(provider.counts).toMatchObject({ capturePosts: 1, directionCalls: 0, imageSubmits: 0, videoSubmits: 0 });
  });

  it('separates live credentials, merchant and approval hosts while preserving existing sandbox draft prices', async () => {
    await start();
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET amount = '9.99' WHERE id = ?").bind(id).run();
    const sandbox = await getJob(bindings, id);
    const live = { ...bindings, TALEMBER_PAYMENT_ENVIRONMENT: 'live',
      PAYPAL_LIVE_CLIENT_ID: 'synthetic-live-client', PAYPAL_LIVE_CLIENT_SECRET: 'synthetic-live-secret',
      PAYPAL_LIVE_MERCHANT_ID: 'SYNTHETICMERCHANT', TALEMBER_SUPPORT_URL: 'https://support.example.test', TALEMBER_BUSINESS_NAME: 'Synthetic business' };
    const preserved = await createOrder(live, sandbox);
    expect(preserved.approval).toContain('www.sandbox.paypal.com');
    expect(provider.events.find(e => e.path === '/v2/checkout/orders')!.body!.purchase_units)
      .toEqual(expect.arrayContaining([expect.objectContaining({ amount: { currency_code: 'USD', value: '9.99' } })]));
    provider = createProviderFixture({ video, paymentEnvironment: 'live' });
    vi.stubGlobal('fetch', provider.fetch);
    const created = await newJob(live, 'https://talember.test');
    const fresh = created.job;
    expect(fresh).toMatchObject({ amount: '19.99', payment_environment: 'live' });
    const order = await createOrder(live, fresh);
    expect(order.approval).toContain('https://www.paypal.com/checkoutnow');
    expect(provider.events.find(e => e.path === '/v2/checkout/orders')!.body!.payment_source)
      .toMatchObject({ paypal: { experience_context: { landing_page: 'GUEST_CHECKOUT', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW' } } });
    expect(provider.events.every(e => e.host === 'api-m.paypal.com')).toBe(true);
    await expect(createOrder({ ...live, PAYPAL_LIVE_MERCHANT_ID: 'WRONG' }, fresh)).rejects.toThrow();
    await expect(createOrder({ ...live, PAYPAL_LIVE_CLIENT_SECRET: undefined }, fresh)).rejects.toThrow();
    expect(await inspectOrder(live, { ...fresh, order_id: order.id, payee_id: order.payee })).toEqual({ status: 'CREATED', capture: null });
    expect(await getJob(bindings, sandbox.id)).toMatchObject({ amount: '9.99', payment_environment: 'sandbox' });
    const liveForm = checkout(); liveForm.set('csrf', fresh.csrf);
    const context = createExecutionContext();
    const submitted = await worker.fetch(new Request('https://talember.test/create/checkout', {
      method: 'POST', headers: { Cookie: `__Host-talember-creation=${created.token}`, Origin: 'https://talember.test', Accept: 'application/json' }, body: liveForm,
    }), live, context);
    await waitOnExecutionContext(context);
    expect(submitted.status).toBe(200);
    provider.approve(); clock += 30_000;
    await progress(live, fresh.id);
    expect(await bindings.TALEMBER_DB.prepare('SELECT amount, payment_environment FROM creation_payments WHERE job_id = ?').bind(fresh.id).first())
      .toEqual({ amount: '19.99', payment_environment: 'live' });
    expect(provider.counts.capturePosts).toBe(1);
    expect(provider.events.every(e => e.host === 'api-m.paypal.com')).toBe(true);
  });

  it('permits only verified unpaid editing and exposes localized support, privacy and submission errors', async () => {
    await start();
    await request('/create/checkout', checkout());
    const original = await getJob(bindings, id);
    const response = await request('/create/edit', form());
    expect(response.status).toBe(303);
    expect((await getJob(bindings, id)).issue).toBe('unpaid_cancelled');
    expect(await bindings.TALEMBER_DB.prepare('SELECT order_id FROM creation_payment_attempts WHERE job_id = ?').bind(id).first('order_id')).toBe(original.order_id);
    cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const edited = await (await request('/create')).text();
    expect(edited).toContain(original.story!);
    expect(edited).toContain(copy('en').reselect);
    expect(provider.counts.capturePosts).toBe(0);
    // The abandoned order cannot be captured by browser or scheduled recovery.
    provider.approve(); clock += 30_000; await recover(bindings);
    expect(provider.counts.capturePosts).toBe(0);
    await start(); await request('/create/checkout', checkout());
    expect((await request('/create/edit', form())).status).toBe(409);
    for (const language of ['en', 'ru', 'es', 'he'] as const) {
      const support = await (await request(`/support?lang=${language}`)).text();
      expect(support).toContain(copy(language).supportMissing);
      expect(await (await request(`/privacy?lang=${language}`)).text()).toContain(copy(language).privacyBody);
      expect(await (await request(`/refunds?lang=${language}`)).text()).toContain(copy(language).refundBody);
      const invalid = await request(`/create/checkout?lang=${language}`, form({ csrf: 'wrong' }));
      expect(await invalid.json()).toEqual({ error: copy(language).sessionError });
    }
  });
  it('saves the proposed script and submits exactly the approved edits once, preserving payment, queue and privacy boundaries', async () => {
    const home = await request('/');
    expect(home.status).toBe(200);
    expect(home.headers.get('set-cookie')).toBeNull();
    const landing = await home.text();
    expect(landing).toContain('Create your story');
    expect(landing).not.toContain('illustrative-woman-dog-photo.jpg');
    expect(landing).not.toContain('Illustrative source photo');
    expect(landing.match(/<video /g)).toHaveLength(1);
    expect(landing).toContain('/assets/preview/demo.mp4');
    expect(landing).not.toContain('cartoon-woman-dog');
    expect(landing).not.toContain('storybook');
    const qualifiedHome = renderHome(null, 'en', true);
    expect(qualifiedHome.match(/<video /g)).toHaveLength(1);
    expect(qualifiedHome).toContain('src="/assets/preview/demo.mp4"');
    expect(qualifiedHome).toContain('poster="/assets/preview/placeholder.svg"');
    expect(qualifiedHome).toContain('width="1280" height="720"');
    expect(qualifiedHome).toContain('id="home-demo" controls muted loop playsinline');
    expect(qualifiedHome).not.toContain('demo-controls');
    expect(qualifiedHome).not.toContain('demo-sound');
    expect(qualifiedHome).not.toContain('storybook');
    expect(qualifiedHome).toContain('Animation example');
    expect(qualifiedHome).not.toContain('4-second');
    expect(qualifiedHome).not.toContain('demo-play-toggle');
    expect(qualifiedHome).toContain('One 15-second animated video');
    expect(landing).toContain('Approve the animation plan');
    expect(landing).toContain('Review and edit the proposed script before creating your video.');
    expect(landing).not.toContain('Approve your cartoon');
    expect(landing).toContain('USD $19.99');
    for (const section of ['how', 'for-you', 'pricing', 'faq']) expect(landing).toContain(`id="${section}"`);
    expect(await bindings.TALEMBER_DB.prepare('SELECT count(*) AS n FROM creation_jobs').first<number>('n')).toBe(0);
    const assetFetch = vi.fn(async () => new Response('synthetic public asset'));
    const assetEnv = { ...bindings, ASSETS: { fetch: assetFetch } } as unknown as ServiceEnv;
    for (const path of ['demo.mp4', 'placeholder.svg'])
      expect((await worker.fetch(new Request(`https://talember.test/assets/preview/${path}`), assetEnv, createExecutionContext())).status).toBe(200);
    expect(assetFetch).toHaveBeenCalledTimes(2);
    for (const path of ['cartoon-v1.svg', 'realism-v1.svg'])
      expect((await worker.fetch(new Request(`https://talember.test/assets/styles/${path}`), assetEnv, createExecutionContext())).status).toBe(200);
    expect((await request('/assets/styles/private-photo.jpg')).status).toBe(401);
    for (const path of ['illustrative-woman-dog-photo.jpg', 'cartoon-woman-dog-demo.mp4', 'cartoon-woman-dog-poster.jpg'])
      expect((await request(`/assets/preview/${path}`)).status).toBe(401);
    expect(provider.events).toHaveLength(0);
    await start();
    const initial = await getJob(bindings, id);
    const emptyHome = await (await request('/')).text();
    expect(emptyHome).toContain('Create your story');
    expect(emptyHome).not.toContain('Resume your story');
    expect(await getJob(bindings, id)).toEqual(initial);
    expect(initial.session_hash).not.toBe(cookie.split('=')[1]);
    expect(initial.style).toBe('cartoon');
    expect(initial.video_format).toBe('match');
    expect(initial.amount).toBe('19.99');
    expect(initial.closing_wish).toBeNull();
    expect(emptyHome).toContain('USD $19.99');
    expect(await (await request('/create')).text()).toContain('USD $19.99');
    provider.loseNextOrderResponse();
    const presetWish = 'Happy birthday';
    const forgedAmount = checkout('cartoon', 'match', presetWish); forgedAmount.set('amount', '0.01');
    forgedAmount.delete('style'); // Current native forms omit the removed selector.
    const [first, duplicate] = await Promise.all([
      request('/create/checkout', forgedAmount), request('/create/checkout', checkout('cartoon', 'match', presetWish)),
    ]);
    expect(first.status).toBe(200); expect(duplicate.status).toBe(200);
    await request('/create/checkout', checkout('storybook', 'vertical', 'Ignore the saved wish'));
    await until('awaiting_paypal');
    expect(await getJob(bindings, id)).toMatchObject({ style: 'cartoon', video_format: 'match', video_ratio: '16:9', amount: '19.99', closing_wish: presetWish });
    const orderCalls = provider.events.filter(e => e.path === '/v2/checkout/orders');
    expect(orderCalls).toHaveLength(2);
    expect(orderCalls[1]!.body).toEqual(orderCalls[0]!.body);
    expect(orderCalls[0]!.body!.purchase_units).toMatchObject([{ amount: { currency_code: 'USD', value: '19.99' } }]);
    expect(provider.counts).toEqual({ orders: 1, capturePosts: 0, directionCalls: 0, imageSubmits: 0, videoSubmits: 0 });
    provider.approve();
    const pending = await getJob(bindings, id);
    await request('/create?payment=return&token=' + pending.order_id);
    expect(await (await request('/create')).text()).toContain('Confirming your payment');
    const beforeHome = await getJob(bindings, id);
    const homeCalls = provider.events.length;
    const unfinishedHome = await (await request('/')).text();
    expect(unfinishedHome).toContain('Resume your story');
    expect(unfinishedHome).not.toContain('id="new-story-form"');
    expect(unfinishedHome).not.toContain('http-equiv="refresh"');
    expect((await request('/create/new', form({ confirmation: 'saved' }))).status).toBe(409);
    expect(await getJob(bindings, id)).toEqual(beforeHome);
    expect(provider.events).toHaveLength(homeCalls);
    expect(provider.counts.directionCalls).toBe(0);
    provider.failNextDownload();
    const original = await until('selected');
    expect(await bindings.TALEMBER_DB.prepare('SELECT amount FROM creation_payments WHERE job_id = ?').bind(id).first<string>('amount')).toBe('19.99');
    expect(original.selected).toBe('original');
    expect(provider.counts).toEqual({ orders: 1, capturePosts: 1, directionCalls: 1, imageSubmits: 1, videoSubmits: 0 });
    const imageResponse = await request('/media/original');
    expect(imageResponse.headers.get('referrer-policy')).toBe('same-origin');
    const image = new Uint8Array(await imageResponse.arrayBuffer());
    expect(image).toEqual(provider.initial);
    expect(png(image)).toEqual({ width: 1280, height: 720 });
    expect(imageResponse.headers.get('cache-control')).toContain('no-store');
    expect((await request('/media/original', undefined, { Cookie: '' })).status).toBe(401);
    const imageDirection = provider.events.find((e) => e.host === 'openrouter.ai')!;
    expect(imageDirection.body!.max_tokens).toBe(1200);
    const messages = imageDirection.body!.messages as { content: string }[];
    const material = JSON.parse(messages[1]!.content);
    expect(material).not.toHaveProperty('closing_wish');
    expect(messages[1]!.content).not.toContain(presetWish);
    expect(material).toMatchObject({ style: 'cartoon', memory: original.story, correction: null,
      characters: { cast: original.cast, count: original.participants }, references: ['photo1','photo2','photo3','photo4'] });
    const format = imageDirection.body!.response_format as { json_schema: { schema: { properties: Record<string, unknown> } } };
    expect(Object.keys(format.json_schema.schema.properties)).toEqual(['framing', 'palette']);
    expect(JSON.parse(original.direction_json!)).toEqual({ framing: 'balanced', palette: 'soft' });
    const imageCall = provider.events.find((e) => e.host === 'queue.fal.run' && e.method === 'POST')!;
    expect(imageCall.body!.aspect_ratio).toBe('auto');
    expect(imageCall.body!.image_urls as string[]).toHaveLength(1);
    expect(imageCall.body!.prompt).toBe(`${IMAGE_PROMPTS.cartoon}\n\n${CLOTHING_PROMPT}`);
    expect(imageCall.body!.prompt).not.toContain(original.story!);
    expect(imageCall.body!.prompt).not.toContain(presetWish);
    const legacyDirection = JSON.stringify({ scene: 'Legacy-only treatment marker.', composition: 'Existing framing.',
      likeness: 'Preserve the reference.', reference_ids: material.references });
    const legacyJob = { ...original, direction_json: legacyDirection };
    const legacyBody = JSON.parse(await submissionBody(bindings, legacyJob, false));
    expect(legacyBody.prompt).toBe(`${IMAGE_PROMPTS.cartoon}\n\n${CLOTHING_PROMPT}`);
    expect(legacyBody.prompt).not.toContain('Legacy-only treatment marker');
    expect(legacyJob.direction_json).toBe(legacyDirection);
    provider.untrustedNextDownloadGrant();
    await expect(falResult(bindings, original.request_id!)).rejects.toMatchObject({ kind: 'invalid' });
    expect(provider.events.at(-1)?.host).toBe('rest.fal.ai');
    const beforeStale = provider.counts;
    expect((await request('/create/improve', form({ correction: 'Change the smile.' }), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await request('/create/improve', form({ correction: 'Change the smile.' }))).status).toBe(410);
    expect((await request('/create/choose', form({ choice: 'corrected' }))).status).toBe(410);
    expect(provider.counts).toEqual(beforeStale);
    const beforePreflight = provider.events.length;
    await expect(direct(bindings, { ...original, original_key: 'synthetic-missing' }, 'video')).rejects.toMatchObject({ kind: 'invalid' });
    await bindings.TALEMBER_PRIVATE_MEDIA.put('synthetic-invalid', new Uint8Array([1, 2, 3]));
    await expect(direct(bindings, { ...original, original_key: 'synthetic-invalid' }, 'video')).rejects.toThrow();
    expect(provider.events).toHaveLength(beforePreflight);
    const draft = await proposal();
    const proposedPage = await (await request('/create')).text();
    expect(proposedPage).toContain('Review your video script');
    expect(proposedPage).toContain('name="script"');
    expect(proposedPage).toContain('Music is optional. Change or remove it in Audio.');
    expect(proposedPage).not.toContain('src="/media/original"');
    expect(proposedPage).not.toContain('src="/media/corrected"');
    expect(proposedPage).not.toContain('http-equiv="refresh"');
    for (const field of ['style', 'subjects', 'environment', 'action', 'camera', 'audio'])
      expect(draft.video_script).toContain(JSON.parse(draft.video_direction_json!)[field]);
    expect(JSON.parse(draft.video_direction_json!).audio).toContain('original instrumental background music');
    expect(draft.video_script).toContain(`Closing message: At 12–15 seconds within the 15-second video`);
    expect(draft.video_script).toContain(`Do not speak it:\n${presetWish}`);
    expect(draft.video_script!.split(presetWish)).toHaveLength(2);
    const directionSystem = (provider.events.filter(e => e.host === 'openrouter.ai').at(-1)!.body!.messages as { content: unknown }[])[0]!.content;
    expect(directionSystem).toContain('subtle original instrumental background music matching the story’s mood and pace');
    expect(directionSystem).toContain('Respect an explicit customer request for no music.');
    const waitingEvents = provider.events.length;
    await expect(videoBody(bindings, draft)).rejects.toMatchObject({ kind: 'invalid' });
    await Promise.all([tick(), tick()]);
    const waitingCtx = createExecutionContext();
    await worker.scheduled(createScheduledController(), bindings, waitingCtx);
    await waitOnExecutionContext(waitingCtx);
    await request('/create?advance=1');
    expect(provider.events).toHaveLength(waitingEvents);
    expect(provider.counts.videoSubmits).toBe(0);
    const edited = '  Synthetic edit: Ana uses her Acme Q7 camera; Max gives a side hug. Keep her smile. Audio: No music or speech.  ';
    const savedResponse = await request('/create/script', scriptForm(draft, 'save', edited));
    expect(savedResponse.status).toBe(200);
    const editedDraft = await getJob(bindings, id);
    expect(editedDraft.closing_wish).toBe(presetWish); // Editing the plan does not rewrite the frozen snapshot.
    expect(editedDraft).toMatchObject({ video_script: edited, video_script_revision: 2, video_script_approved_at: null, video_script_source_key: original.original_key });
    expect(await (await request('/create')).text()).toContain(edited);
    const staleText = 'My stale edits must remain visible <script>alert(1)</script>';
    const stale = await request('/create/script', scriptForm(draft, 'save', staleText), { Accept: 'text/html' });
    expect(stale.status).toBe(409);
    const stalePage = await stale.text();
    expect(stalePage).toContain('My stale edits must remain visible &lt;script&gt;');
    expect(stalePage).not.toContain('<script>alert(1)</script>');
    expect((await request('/create/script', scriptForm(draft))).status).toBe(409);
    const invalid = await request('/create/script', scriptForm(editedDraft, 'approve', 'Tiny'), { Accept: 'text/html' });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain('>Tiny</textarea>');
    expect((await request('/create/script', scriptForm(editedDraft, 'approve', 'x'.repeat(12001)))).status).toBe(400);
    const invalidCsrf = scriptForm(editedDraft); invalidCsrf.set('csrf', 'x'.repeat(64));
    expect((await request('/create/script', invalidCsrf)).status).toBe(403);
    expect((await request('/create/script', scriptForm(editedDraft), { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await request('/create/script', scriptForm(editedDraft), { Origin: 'null' })).status).toBe(403);
    expect((await request('/create/script', scriptForm(editedDraft), { Cookie: '' })).status).toBe(401);
    const approvals = await Promise.all([
      request('/create/script', scriptForm(editedDraft)), request('/create/script', scriptForm(editedDraft)),
    ]);
    expect(approvals.map(response => response.status)).toEqual([200, 200]);
    const approved = await getJob(bindings, id);
    expect(approved).toMatchObject({ video_script: edited, video_script_revision: 3, video_script_approved_revision: 3 });
    expect(approved.video_script_approved_at).toBeTruthy();
    const late = await request('/create/script', scriptForm(editedDraft, 'save', 'Late edits cannot replace approval.'), { Accept: 'text/html' });
    expect(late.status).toBe(409);
    const latePage = await late.text();
    expect(latePage).toContain('Late edits cannot replace approval.</textarea>');
    expect(latePage).not.toContain('http-equiv="refresh"');
    expect(provider.events).toHaveLength(waitingEvents);
    provider.queueNextRequest();
    const queued = await tick();
    expect(queued.phase).toBe('video_generating');
    expect(queued.video_request_id).toBeTruthy();
    const queuedCounts = provider.counts;
    const reload = await (await request('/create')).text();
    expect(reload).toContain('Creating your video');
    expect(reload).not.toContain('src="/media/original"');
    expect(reload).not.toContain('/create/improve'); expect(reload).not.toContain('/create/choose');
    provider.failNextRetrieval('status');
    expect(await tick()).toMatchObject({ phase: 'video_generating', video_request_id: queued.video_request_id });
    clock += 15_000;
    await tick(); // The same request is still IN_PROGRESS.
    provider.failNextRetrieval('result');
    expect(await tick()).toMatchObject({ phase: 'video_generating', video_request_id: queued.video_request_id });
    expect(provider.errorBodies).toEqual({ canceled: 2, read: 0 });
    expect(provider.counts).toEqual(queuedCounts);
    clock += 15_000;
    await Promise.all([tick(), tick()]);
    const completed = await until('complete');
    expect(completed.selected).toBe('original');
    expect(completed.video_request_id).toBe(queued.video_request_id);
    expect(provider.counts).toEqual(queuedCounts);
    const videoDownloads = provider.events.filter(e => e.host === 'v3b.fal.media' && e.path.endsWith('.mp4'));
    expect(videoDownloads).toHaveLength(1);
    expect(videoDownloads[0]!.method).toBe('GET');
    const storedVideo = await bindings.TALEMBER_PRIVATE_MEDIA.get(completed.video_key!);
    expect(storedVideo).not.toBeNull();
    expect(new Uint8Array(await storedVideo!.arrayBuffer())).toEqual(video);
    const movieRequest = provider.events.find((e) => e.path === '/bytedance/seedance-2.0/reference-to-video')!;
    expect(movieRequest.body).toMatchObject({ duration: '15', resolution: '720p', aspect_ratio: '16:9', generate_audio: true, end_user_id: id });
    expect(movieRequest.body!.image_urls as string[]).toHaveLength(4);
    const cartoons = provider.events.filter(e => e.host === 'queue.fal.run' && e.method === 'POST' && e.path === '/fal-ai/nano-banana-pro/edit');
    expect(cartoons).toHaveLength(4);
    expect(cartoons[0]!.body!.image_urls as string[]).toHaveLength(1);
    for (const cartoon of cartoons) {
      expect(cartoon.body!.image_urls as string[]).toHaveLength(1);
      expect(cartoon.body!.prompt).toBe(cartoons[0]!.body!.prompt);
      expect(cartoon.body!.prompt).toBe(`${IMAGE_PROMPTS.cartoon}\n\n${CLOTHING_PROMPT}`);
    }
    const styleCalls = provider.events.filter(e => e.host === 'openrouter.ai' &&
      (e.body!.response_format as { json_schema: { name: string } }).json_schema.name === 'talember_rendering_style');
    expect(styleCalls).toHaveLength(0);
    const readyReferences = JSON.parse(completed.references_json!) as { key: string; request: string }[];
    expect(readyReferences).toHaveLength(3);
    expect(new Set(readyReferences.map(row => row.request)).size).toBe(3);
    expect(completed.script_references_json).toBe(completed.references_json);
    const reference = (movieRequest.body!.image_urls as string[])[0]!;
    expect(new URL(reference).origin).toBe('https://v3b.fal.media');
    expect([...new URL(reference).searchParams.keys()]).toEqual(['identity']);
    expect(provider.uploaded(reference)).toEqual(image);
    expect(movieRequest.body!.prompt).toBe(edited);
    expect(movieRequest.body!.prompt).not.toContain(presetWish); // Removing it in review wins over the original field.
    expect(movieRequest.body!.prompt).not.toContain(original.story!);
    const videoDirection = provider.events.filter(e => e.host === 'openrouter.ai').at(-1)!;
    expect(visionInput(videoDirection.body!, image)).toMatchObject({ references: ['scene'], story: original.story, style: 'cartoon', video_ratio: '16:9', selected_correction: null, closing_wish: presetWish });
    const saved = JSON.parse(completed.video_direction_json!);
    expect(Object.keys(saved)).toEqual(['style', 'subjects', 'environment', 'action', 'camera', 'audio', 'reference_ids']);
    expect(JSON.stringify(completed)).not.toContain('identity=');
    expect(JSON.stringify(completed)).not.toContain('data:image');
    const beforeUntrusted = provider.events.length;
    provider.untrustedNextUpload();
    await expect(videoBody(bindings, completed)).rejects.toMatchObject({ kind: 'private' });
    expect(provider.events).toHaveLength(beforeUntrusted + 1); // No image PUT to the foreign host.
    provider.untrustedNextSignedUrl();
    await expect(videoBody(bindings, completed)).rejects.toMatchObject({ kind: 'private' });
    const submissionsBeforeCorruption = provider.counts.videoSubmits;
    provider.corruptNextSignedRead();
    await expect(videoBody(bindings, completed)).rejects.toBeDefined();
    expect(provider.counts.videoSubmits).toBe(submissionsBeforeCorruption);
    expect(provider.events.every(e => e.host !== 'attacker.invalid')).toBe(true);
    expect(provider.counts).toEqual(queuedCounts);
    const output = await request('/media/video?download=1');
    expect(output.status).toBe(200);
    const bytes = new Uint8Array(await output.arrayBuffer());
    expect(bytes).toEqual(video); expect(() => mp4(bytes, '16:9')).not.toThrow();
    expect(() => mp4(bytes, '9:16')).toThrow();
    expect(output.headers.get('content-disposition')).toContain('talember-story.mp4');
    expect(output.headers.get('cache-control')).toContain('no-store');
    expect((await request('/media/video', undefined, { Cookie: '' })).status).toBe(401);
    const range = await request('/media/video', undefined, { Range: 'bytes=0-31' });
    expect(range.status).toBe(206);
    expect(new Uint8Array(await range.arrayBuffer())).toEqual(video.slice(0,32));
    const completedPage = await (await request('/create')).text();
    expect(completedPage).toContain('<video controls');
    expect(completedPage).not.toContain('v3b.fal.media');
    expect(await (await request('/api/job')).text()).not.toContain('v3b.fal.media');
    await tick();
    expect((await request('/create/choose', form({ choice: 'original' }))).status).toBe(410);
    expect(provider.counts).toEqual({ orders: 1, capturePosts: 1, directionCalls: 2, imageSubmits: 4, videoSubmits: 1 });
    expect(await bindings.TALEMBER_DB.prepare('SELECT count(*) AS n FROM creation_payments').first<number>('n')).toBe(1);
    const beforeNew = await getJob(bindings, id);
    const beforeNewCalls = provider.events.length;
    const savedHome = await (await request('/')).text();
    expect(savedHome).toContain('data-phase="home"');
    expect(savedHome).toContain('View your video');
    expect(savedHome).toContain('I’ve saved my video');
    expect(savedHome.match(/<video /g)).toHaveLength(1);
    expect(savedHome).toContain('src="/assets/preview/demo.mp4"');
    expect(savedHome).not.toContain('src="/media/video');
    expect((await request('/create/new')).status).toBe(404);
    expect((await request('/create/new', form())).status).toBe(400);
    expect((await request('/create/new', form({ confirmation: 'saved' }), { Origin: 'null' })).status).toBe(403);
    expect((await request('/create/new', form({ confirmation: 'saved', csrf: 'invalid' }))).status).toBe(403);
    // Content expires before the video. Starting another story must still work
    // after that point, without deleting the completed file or payment receipt.
    clock = beforeNew.content_expires_at! + 1;
    const oldCookie = cookie;
    const hebrewHome = await (await request('/?lang=he')).text();
    expect(hebrewHome).toContain('action="/create/new?lang=he"');
    const [next, nextDuplicate] = await Promise.all([
      request('/create/new?lang=he', form({ confirmation: 'saved' }), { Accept: 'text/html' }),
      request('/create/new?lang=he', form({ confirmation: 'saved' }), { Accept: 'text/html' }),
    ]);
    expect(next.status).toBe(303); expect(nextDuplicate.status).toBe(303);
    expect(next.headers.get('location')).toBe('/?lang=he');
    expect(next.headers.get('set-cookie')).toBe(nextDuplicate.headers.get('set-cookie'));
    cookie = next.headers.get('set-cookie')!.split(';')[0]!;
    expect(cookie).not.toBe(oldCookie);
    const returnedHome = await (await request(next.headers.get('location')!)).text();
    expect(returnedHome).toContain('data-phase="home"');
    expect(returnedHome).toContain('lang="he" dir="rtl"');
    expect(returnedHome).toContain('יצירת הסיפור שלכם');
    expect(returnedHome).not.toContain('המשך הסיפור שלכם');
    const newEnglishHome = await (await request('/?lang=en')).text();
    expect(newEnglishHome).toContain('Create your story');
    expect(newEnglishHome).not.toContain('Resume your story');
    expect(await bindings.TALEMBER_DB.prepare('SELECT count(*) AS n FROM creation_jobs').first<number>('n')).toBe(2);
    const fresh = (await bindings.TALEMBER_DB.prepare('SELECT * FROM creation_jobs WHERE id != ?').bind(id).first<Job>())!;
    expect(fresh).toMatchObject({ phase: 'draft', amount: '19.99', style: 'cartoon', video_format: 'match', story: null, photos_json: null,
      order_id: null, capture_id: null, paid_at: null, request_id: null, video_request_id: null, video_key: null });
    expect(fresh.csrf).not.toBe(csrf);
    expect(await getJob(bindings, id)).toEqual(beforeNew);
    expect(new Uint8Array(await (await bindings.TALEMBER_PRIVATE_MEDIA.get(beforeNew.video_key!))!.arrayBuffer())).toEqual(video);
    expect(await bindings.TALEMBER_DB.prepare('SELECT count(*) AS n FROM creation_payments').first<number>('n')).toBe(1);
    expect((await request('/media/video')).status).toBe(404);
    expect((await request('/create/checkout', checkout())).status).toBe(403); // Stale tab's CSRF cannot purchase the new story.
    const blank = await (await request('/create')).text();
    expect(blank).toContain('id="creation-form"');
    expect(blank).not.toContain('<video');
    expect(blank).not.toContain(beforeNew.story!);
    const replay = await request('/create/new', form({ confirmation: 'saved' }), { Cookie: oldCookie });
    expect(replay.headers.get('set-cookie')).toBe(next.headers.get('set-cookie'));
    expect(await bindings.TALEMBER_DB.prepare('SELECT count(*) AS n FROM creation_jobs').first<number>('n')).toBe(2);
    const restrictedEnv = { ...bindings, TALEMBER_CREATION_TEST_JOB: id };
    const restrictedPage = await worker.fetch(new Request('https://talember.test/create', { headers: { Cookie: cookie } }), restrictedEnv, createExecutionContext());
    expect(await restrictedPage.text()).toContain('type="submit" disabled');
    const freshCheckout = checkout(); freshCheckout.set('csrf', fresh.csrf);
    const restrictedCheckout = await worker.fetch(new Request('https://talember.test/create/checkout', {
      method: 'POST', headers: { Cookie: cookie, Origin: 'https://talember.test', Accept: 'application/json' }, body: freshCheckout,
    }), restrictedEnv, createExecutionContext());
    expect(restrictedCheckout.status).toBe(503);
    expect(provider.events).toHaveLength(beforeNewCalls);
  });

  it('recovers automatically with no browser, finishes an already queued correction, and honors an existing selected source', async () => {
    await start();
    await request('/create/checkout', checkout());
    provider.approve();
    provider.queueNextRequest();
    clock += 30_000;
    for (let n = 0; n < 3; n++) {
      const ctx = createExecutionContext();
      await worker.scheduled(createScheduledController(), bindings, ctx);
      await waitOnExecutionContext(ctx);
      clock += 5 * 60_000;
    }
    expect((await getJob(bindings, id)).phase).toBe('generating');
    const original = await until('selected');
    expect(original.selected).toBe('original');
    expect(original.closing_wish).toBeNull();
    const legacy = provider.restoreCorrection();
    const instruction = 'Make the sunset warmer.';
    const direction = JSON.stringify({ framing: 'closer', palette: 'warm' });
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase = 'correction_submitting', selected = NULL, correction = ?, correction_direction_json = ?, correction_direction_request_id = ?, correction_request_id = ?, correction_submitted_at = ? WHERE id = ?")
      .bind(instruction, direction, legacy.directionId, legacy.id, clock, id).run();
    const counts = provider.counts;
    await tick();
    expect((await getJob(bindings, id)).phase).toBe('correction_generating');
    const reload = await (await request('/create')).text();
    expect(reload).toContain('class="center progress"');
    expect(reload).not.toContain('/create/improve');
    await tick(); await tick();
    expect(await getJob(bindings, id)).toMatchObject({ phase: 'correction_generating', correction: instruction, correction_request_id: legacy.id });
    const restored = await until('selected');
    expect(restored).toMatchObject({ selected: 'original', correction_request_id: legacy.id, correction_direction_json: direction });
    expect(new Uint8Array(await (await request('/media/corrected')).arrayBuffer())).toEqual(provider.corrected);
    expect(provider.counts).toEqual(counts);
    // An old unselected choice page also advances to the original without buying an edit.
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase = 'choice', selected = NULL WHERE id = ?").bind(id).run();
    await tick();
    expect((await getJob(bindings, id)).selected).toBe('original');
    expect(provider.counts).toEqual(counts);
    const legacyVideo = JSON.stringify({ scene: 'Existing paid action.', composition: 'Existing paid camera.', likeness: 'Existing paid continuity.', reference_ids: ['scene'] });
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase = 'video_directed', references_json=NULL, script_references_json=NULL, video_direction_json = ?, video_direction_request_id = ? WHERE id = ?")
      .bind(legacyVideo, 'gen-existing-video-direction', id).run();
    const legacyDraft = await proposal();
    expect(provider.counts).toEqual(counts);
    const nativeSave = await request('/create/script', scriptForm(legacyDraft, 'save'), { Accept: 'text/html' });
    expect(nativeSave.status).toBe(303);
    expect(nativeSave.headers.get('location')).toBe('/create?saved=1');
    const nativeApproval = await request('/create/script', scriptForm(await getJob(bindings, id)), { Accept: 'text/html' });
    expect(nativeApproval.status).toBe(303);
    expect(nativeApproval.headers.get('location')).toBe('/create');
    provider.queueNextRequest();
    const acknowledged = await tick();
    // A request acknowledged before this feature has no script approval columns.
    // Its saved identity still continues; it must never purchase a replacement.
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase = 'video_submitting', video_script = NULL, video_script_approved_at = NULL, video_script_approved_revision = NULL WHERE id = ?")
      .bind(id).run();
    await tick();
    expect(await getJob(bindings, id)).toMatchObject({ phase: 'video_generating', video_request_id: acknowledged.video_request_id });
    // A browser may close immediately after approval. Cron resumes that exact text.
    provider.failNextDownload();
    const submissionsBeforeRecovery = provider.counts.videoSubmits;
    for (let n = 0; n < 5 && (await getJob(bindings, id)).phase !== 'complete'; n++) {
      clock += 5 * 60_000;
      const approvedCtx = createExecutionContext();
      await worker.scheduled(createScheduledController(), bindings, approvedCtx);
      await waitOnExecutionContext(approvedCtx);
    }
    expect((await getJob(bindings, id)).phase).toBe('complete');
    expect((await getJob(bindings, id)).video_request_id).toBe(acknowledged.video_request_id);
    expect(provider.counts.videoSubmits).toBe(submissionsBeforeRecovery);
    expect(provider.counts.videoSubmits).toBe(1);
    expect(provider.counts.directionCalls).toBe(counts.directionCalls);
    expect(await getJob(bindings, id)).toMatchObject({ video_direction_json: legacyVideo, video_direction_request_id: 'gen-existing-video-direction' });
    const legacyRequest = provider.events.find(e => e.path === '/bytedance/seedance-2.0/reference-to-video')!;
    expect(legacyRequest.body!.prompt).toContain('Existing paid action.');
    expect(legacyRequest.body!.prompt).not.toContain('Closing message:');
    expect(provider.uploaded((legacyRequest.body!.image_urls as string[])[0]!)).toEqual(provider.initial);

    cookie = '';
    const noMusicStory = 'Anna and Max walk with their dog Milo beside the sea at sunset. No background music.';
    const customWish = 'С любовью, Анна!';
    const realistic = await paidScene('cartoon', 'vertical', noMusicStory, customWish);
    expect(realistic.closing_wish).toBe(customWish);
    // A historical paid realistic snapshot must remain usable even though new
    // checkouts no longer offer that style.
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET style = 'realistic' WHERE id = ?").bind(id).run();
    expect(realistic).toMatchObject({ video_format: 'vertical', video_ratio: '9:16' });
    const still = provider.events.filter(e => e.path === '/fal-ai/nano-banana-pro/edit').at(-1)!;
    expect(still.body!.aspect_ratio).toBe('auto'); // Still stays landscape despite vertical video override.
    expect(still.body!.prompt).toBe(`${IMAGE_PROMPTS.cartoon}\n\n${CLOTHING_PROMPT}`);
    const selectedKey = 'creation/' + id + '/corrected.png';
    await bindings.TALEMBER_PRIVATE_MEDIA.put(selectedKey, provider.corrected);
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase = 'choice', corrected_key = ?, selected = 'corrected', correction = ? WHERE id = ?")
      .bind(selectedKey, instruction, id).run();
    await tick();
    expect((await getJob(bindings, id)).selected).toBe('corrected');
    await request('/create?lang=he');
    await approveVideo();
    const final = await until('complete');
    expect(final.selected).toBe('corrected');
    const movie = provider.events.filter(e => e.path === '/bytedance/seedance-2.0/reference-to-video').at(-1)!;
    expect(movie.body).toMatchObject({ aspect_ratio: '9:16', resolution: '720p' });
    expect(movie.body!.prompt).toContain('realistic');
    expect(movie.body!.prompt).not.toContain('cartoon');
    expect(JSON.parse(final.video_direction_json!).audio).toBe('Soft natural ambience. No background music, vocals or dialogue.');
    expect(movie.body!.prompt).toBe(final.video_script);
    expect(movie.body!.prompt).toContain(customWish);
    expect(movie.body!.prompt).toContain('12–15');
    expect(movie.body!.prompt).toContain('ברכה בסיום');
    expect(movie.body!.prompt).not.toContain('instrumental background music');
    expect(provider.uploaded((movie.body!.image_urls as string[])[0]!)).toEqual(provider.corrected);
    const videoDirection = provider.events.filter(e => e.host === 'openrouter.ai').at(-1)!;
    expect(visionInput(videoDirection.body!, provider.corrected)).toMatchObject({ style: 'realistic', video_ratio: '9:16', selected_correction: instruction, locale: 'he', story: noMusicStory, closing_wish: customWish });
    const bytes = new Uint8Array(await (await request('/media/video')).arrayBuffer());
    expect(bytes).toEqual(verticalVideo);
    expect(() => mp4(bytes, '9:16')).not.toThrow();
    const finalCounts = provider.counts;
    await Promise.all([tick(), tick()]);
    expect(provider.counts).toEqual(finalCounts);
  });

  it('rejects mismatched captured-payment evidence and forged returns before any creative call', async () => {
    await start();
    await request('/create/checkout', checkout());
    provider.approve();
    provider.tamperPayment();
    expect((await request('/create?payment=return&token=OTHER')).status).toBe(400);
    const job = await getJob(bindings, id);
    await request(`/create?payment=return&token=${job.order_id}`);
    await tick();
    expect((await getJob(bindings, id)).phase).toBe('attention');
    expect(provider.counts.directionCalls).toBe(0);
    expect(provider.counts.imageSubmits).toBe(0);
    expect(provider.counts.capturePosts).toBe(0);
    provider.tamperPayment(null);
    cookie = '';
    await start();
    await request('/create/checkout', checkout());
    provider.tamperPayment('capture');
    const captureMismatch = await getJob(bindings, id);
    await request(`/create?payment=return&token=${captureMismatch.order_id}`);
    await tick();
    expect(await getJob(bindings, id)).toMatchObject({ phase: 'attention', amount: '19.99', paid_at: null });
    expect(provider.counts.directionCalls).toBe(0);
    expect(provider.counts.imageSubmits).toBe(0);
    expect(await bindings.TALEMBER_DB.prepare('SELECT count(*) AS n FROM creation_payments').first<number>('n')).toBe(0);
  });

  it('waits for pending capture, skips unsent legacy corrections, and never replays an indeterminate video submission', async () => {
    await start();
    // Represents an existing draft whose price was retained by migration0035.
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET amount = '9.99' WHERE id = ?").bind(id).run();
    expect(await (await request('/create')).text()).toContain('USD $9.99');
    expect(await (await request('/')).text()).toContain('USD $19.99');
    await request('/create/checkout', checkout());
    expect(provider.events.find(e => e.path === '/v2/checkout/orders')!.body!.purchase_units)
      .toMatchObject([{ amount: { currency_code: 'USD', value: '9.99' } }]);
    provider.approve();
    provider.pendingCapture(true);
    const job = await getJob(bindings, id);
    await request(`/create?payment=return&token=${job.order_id}`);
    await tick();
    expect((await getJob(bindings, id)).paid_at).toBeNull();
    expect(provider.counts.capturePosts).toBe(1);
    expect(provider.counts.directionCalls).toBe(0);
    clock += 30_000;
    await tick();
    expect(provider.counts.capturePosts).toBe(1);
    provider.pendingCapture(false);
    clock += 30_000;
    await until('selected');
    expect((await getJob(bindings, id)).amount).toBe('9.99');
    expect(await bindings.TALEMBER_DB.prepare('SELECT amount FROM creation_payments WHERE job_id = ?').bind(id).first<string>('amount')).toBe('9.99');
    expect(provider.counts.capturePosts).toBe(1);
    expect(provider.counts.directionCalls).toBe(1);
    const counts = provider.counts;
    for (const phase of ['correcting', 'correction_directed']) {
      await bindings.TALEMBER_DB.prepare('UPDATE creation_jobs SET phase = ?, selected = NULL, correction = ? WHERE id = ?')
        .bind(phase, 'Make a different smile.', id).run();
      await tick();
      expect((await getJob(bindings, id)).selected).toBe('original');
      expect(provider.counts).toEqual(counts);
    }
    await approveVideo();
    provider.loseNextSubmission();
    const unknown = await tick();
    expect(unknown).toMatchObject({ phase: 'attention', issue: 'submission_unknown', video_request_id: null });
    expect(provider.counts.videoSubmits).toBe(1);
    const stopped = provider.counts;
    for (let n = 0; n < 3; n++) {
      clock += 180_000;
      await progress(bindings, id);
    }
    expect(provider.counts).toEqual(stopped);
    cookie = '';
    await paidScene();
    await approveVideo();
    provider.queueNextRequest();
    const queued = await tick();
    await tick(); // IN_PROGRESS, not a terminal request failure.
    provider.failNextRetrieval('result', 'request');
    provider.rejectNextErrorCancellation();
    const failed = await tick();
    expect(failed).toMatchObject({ phase: 'attention', issue: 'provider_response', video_request_id: queued.video_request_id, selected: 'original' });
    expect(failed.video_key).toBeNull();
    expect(provider.errorBodies.read).toBe(1);
    const diagnostic = await bindings.TALEMBER_PRIVATE_MEDIA.get(`diagnostics/${id}/${failed.video_request_id}.json`);
    expect(await diagnostic!.json()).toMatchObject({ details: { type: 'truncated', detail: { type: 'non_json' } } });
    const attention = await (await request('/create')).text();
    expect(attention).toContain('Your creation needs a little help');
    expect(attention).not.toContain('class="center progress"');
    expect(attention).not.toContain('downstream_service_unavailable');
    const terminalCalls = provider.events.length;
    await Promise.all([tick(), tick()]);
    expect(provider.events).toHaveLength(terminalCalls);
    // Both documented completed-status error fields and typed result headers
    // independently identify a failed request without reading echoed inputs.
    for (const field of ['error', 'error_type'] as const) {
      provider.failNextCompletedStatus(field);
      await expect(falResult(bindings, failed.video_request_id!, true)).rejects.toMatchObject({ kind: 'invalid' });
      expect(provider.events.at(-1)?.path).toContain('/status?logs=0');
    }
    provider.failNextRetrieval('result', 'type');
    await expect(falResult(bindings, failed.video_request_id!, true)).rejects.toMatchObject({ kind: 'invalid' });
    expect(provider.errorBodies.read).toBe(1);
    cookie = '';
    await paidScene();
    await approveVideo();
    provider.queueNextRequest();
    const missing = await tick();
    await tick();
    const beforeMissing = provider.counts;
    // Exact live response: status COMPLETED, then result 404 without headers.
    provider.failNextRetrieval('result', false, 404);
    const unavailable = await tick();
    expect(unavailable).toMatchObject({
      phase: 'attention', issue: 'provider_response', selected: 'original',
      original_key: missing.original_key, request_id: missing.request_id,
      video_request_id: missing.video_request_id,
      video_direction_request_id: missing.video_direction_request_id,
    });
    expect(unavailable.video_key).toBeNull();
    expect(provider.errorBodies.read).toBe(2);
    const unavailablePage = await (await request('/create')).text();
    expect(unavailablePage).not.toContain('src="/media/original"');
    expect(unavailablePage).not.toContain('class="center progress"');
    const stoppedRequests = provider.events.length;
    await Promise.all([tick(), tick()]);
    expect(provider.events).toHaveLength(stoppedRequests);
    expect(provider.counts).toEqual(beforeMissing);
  });

  it('freezes the chosen style and applies its exact preset independently to every photo', async () => {
    for (const style of ['cartoon', 'realistic'] as const) {
      cookie = '';
      const job = await paidScene(style);
      expect(job.style).toBe(style);
      for (let photo = 1; photo <= 4; photo++) {
        const body = JSON.parse(photo === 1 ? await submissionBody(bindings, job, false) : await characterBody(bindings, job, photo));
        expect(body.image_urls).toHaveLength(1);
        expect(body.prompt).toBe(`${IMAGE_PROMPTS[style]}\n\n${CLOTHING_PROMPT}`);
        expect(body.prompt.startsWith('Style:')).toBe(false);
      }
      // A later checkout cannot replace the already paid style.
      await request('/create/checkout', checkout(style === 'cartoon' ? 'realistic' : 'cartoon'));
      expect((await getJob(bindings, id)).style).toBe(style);
    }
  });

  it('holds OpenRouter comparison results and never retries an uncertain image purchase', async () => {
    await paidScene();
    const model = 'openai/gpt-image-2.5-sunburst';
    const setup = async () => bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase='selected', issue=NULL, next_at=0, references_json=? WHERE id=?")
      .bind(JSON.stringify([{ photo: 2, model, reviewAfter: true }]), id).run();
    await setup();
    let calls = 0;
    vi.stubGlobal('fetch', async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      const body = JSON.parse(String(init!.body));
      expect(body.prompt).toBe(`${IMAGE_PROMPTS.cartoon}\n\n${CLOTHING_PROMPT}`);
      expect(body.model).toBe(model);
      expect(body.input_references).toHaveLength(1);
      return Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...provider.corrected)) }] });
    });
    const ready = await tick();
    expect(ready).toMatchObject({ phase: 'attention', issue: 'owner_preview', video_request_id: null });
    expect(JSON.parse(ready.references_json!)[0].key).toBe(`creation/${id}/reference-2.png`);
    expect(calls).toBe(1);
    await setup();
    vi.stubGlobal('fetch', async () => { calls++; throw new Error('uncertain transport'); });
    expect(await tick()).toMatchObject({ phase: 'attention', issue: 'submission_unknown' });
    await tick();
    expect(calls).toBe(2);
  });

  it('renders the approved greeting after video, retaining the source across renderer outages without repurchasing', async () => {
    let attempts = 0;
    bindings.TALEMBER_OVERLAY_ENABLED = 'true';
    bindings.TALEMBER_RENDERER = { fetch: async (_url: string, init: RequestInit) => {
      attempts++;
      const headers = new Headers(init.headers);
      const metadata = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(headers.get('X-Greeting')!), c => c.charCodeAt(0))));
      expect(metadata.text).toBe('Маша, мы тебя любим! ❤️ 🎉');
      expect(metadata.effect).toBe('celebration');
      expect(metadata.color).toBe('multicolor');
      expect(metadata.font).toBe('caveat');
      expect(init.body).toBeInstanceOf(Uint8Array);
      return attempts === 1 ? new Response(null, { status: 503 })
        : new Response(video, { headers: { 'Content-Type': 'video/mp4' } });
    } } as unknown as Fetcher;
    try {
      await paidScene('cartoon', 'match', undefined, 'Original greeting');
      const draft = await proposal();
      expect(draft.overlay_version).toBe(1);
      expect(draft.video_script).not.toContain('Original greeting');
      const data = scriptForm(draft);
      data.set('greeting', 'Маша, мы тебя любим! ❤️ 🎉');
      data.set('effect', 'invalid');
      expect((await request('/create/script', data)).status).toBe(400);
      data.set('effect', 'celebration');
      data.set('color', 'invalid');
      expect((await request('/create/script', data)).status).toBe(400);
      data.set('color', 'multicolor');
      data.set('font', 'fredoka');
      expect((await request('/create/script', data)).status).toBe(400);
      data.set('font', 'caveat');
      expect((await request('/create/script', data)).status).toBe(200);
      await until('video_generating');
      for (let i = 0; i < 10 && !(await getJob(bindings, id)).raw_video_key; i++) await tick();
      const raw = (await getJob(bindings, id)).raw_video_key;
      expect(raw).toBeTruthy();
      const review = await getJob(bindings,id);
      expect(review.overlay_review).toBe(1);
      expect(attempts).toBe(0);
      expect((await request('/media/raw')).status).toBe(200);
      const placement = new FormData();
      placement.set('csrf',review.csrf); placement.set('intent','finish'); placement.set('revision',String(review.overlay_revision));
      placement.set('x','50'); placement.set('y','90'); placement.set('scale','999');
      placement.set('layout_elements',JSON.stringify([{id:'text',x:50,y:80,scale:65},{id:'heart0',x:10,y:60,scale:100},{id:'firework0',x:90,y:60,scale:120}]));
      expect((await request('/create/placement',placement)).status).toBe(400);
      placement.set('scale','65');
      expect((await request('/create/placement',placement)).status).toBe(200);
      expect((await request('/create/placement',placement)).status).toBe(409);
      await tick();
      const pending = await getJob(bindings, id);
      expect(pending).toMatchObject({ phase: 'video_generating', video_key: null, raw_video_key: raw });
      expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(raw!)).toBeTruthy();
      clock = pending.next_at + 1;
      await until('complete');
      expect(attempts).toBe(2);
      expect(provider.counts.videoSubmits).toBe(1);
    } finally {
      delete bindings.TALEMBER_OVERLAY_ENABLED;
      delete bindings.TALEMBER_RENDERER;
    }
  });

  it('uses Sunburst high quality for every new photo and passes all references to approved video', async () => {
    bindings.TALEMBER_IMAGE_PROVIDER = 'openrouter';
    let calls = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://openrouter.ai/api/v1/images') {
        expect((await getJob(bindings, id)).capture_id).toBeTruthy();
        const body = JSON.parse(String(init!.body));
        expect(body).toMatchObject({ model: 'openai/gpt-image-2.5-sunburst', quality: 'high', n: 1 });
        expect(body.prompt).toBe(`${IMAGE_PROMPTS.cartoon}\n\n${CLOTHING_PROMPT}`);
        expect(body.input_references).toHaveLength(1);
        calls++;
        return Response.json({ data: [{ b64_json: btoa(String.fromCharCode(...provider.initial)) }] });
      }
      return provider.fetch(input, init);
    });
    try {
      await paidScene();
      const review = await proposal();
      expect(calls).toBe(4);
      expect(JSON.parse(review.references_json!)).toHaveLength(3);
      for (const locale of ['en', 'ru', 'es', 'he'] as const)
        expect(proposedScript({ ...review, locale })).toContain(continuity[locale]);
      expect(review.video_script!.split(continuity.en)).toHaveLength(2);
      expect(review.video_request_id).toBeNull();
      await approveVideo();
      await until('complete');
      const movie = provider.events.find(e => e.path.endsWith('/reference-to-video') && e.method === 'POST')!;
      expect(movie.body!.image_urls).toHaveLength(4);
      expect(movie.body!.prompt).toContain(continuity.en);
      expect(calls).toBe(4);
    } finally { bindings.TALEMBER_IMAGE_PROVIDER = 'fal'; }
  });

  it('retries zero-billed failed references at most twice with durable delay and preserved first image', async () => {
    const first = await paidScene();
    await bindings.TALEMBER_DB.prepare('UPDATE creation_jobs SET references_json=? WHERE id=?')
      .bind(JSON.stringify([{ photo: 2, reviewAfter: true }]), id).run();
    const baseline = provider.counts.imageSubmits;
    for (let attempt = 0; attempt < 3; attempt++) {
      await tick(); // Submit only this reference.
      provider.failNextWithBilling('0');
      const failed = await tick();
      expect(failed.original_key).toBe(first.original_key);
      expect(provider.counts.imageSubmits).toBe(baseline + attempt + 1);
      if (attempt < 2) {
        expect(failed.phase).toBe('selected');
        expect(failed.next_at).toBeGreaterThan(clock);
        await Promise.all([tick(), tick()]);
        expect(provider.counts.imageSubmits).toBe(baseline + attempt + 1);
        clock = failed.next_at + 1;
      } else expect(failed).toMatchObject({ phase: 'attention', issue: 'provider_response' });
    }
    await recover(bindings); await tick();
    expect(provider.counts.imageSubmits).toBe(baseline + 3);
    expect(provider.counts.videoSubmits).toBe(0);
    const ledger = await bindings.TALEMBER_PRIVATE_MEDIA.get(`diagnostics/${id}/retries-reference-2.json`);
    expect(await ledger!.json()).toHaveLength(2);
  });

  it('never replaces a failed reference when billing is charged, missing or malformed', async () => {
    for (const units of [undefined, '1', '', 'unknown']) {
      cookie = '';
      await paidScene();
      await tick();
      const before = provider.counts.imageSubmits;
      provider.failNextWithBilling(units);
      expect(await tick()).toMatchObject({ phase: 'attention', issue: 'provider_response' });
      clock += 300_000;
      await recover(bindings); await tick();
      expect(provider.counts.imageSubmits).toBe(before);
    }
  });

  it('retries an uncharged video failure with the same approval and script', async () => {
    await paidScene(); await approveVideo();
    provider.queueNextRequest();
    const generating = await until('video_generating');
    provider.failNextWithBilling('0.0');
    const retry = await until('video_directed');
    expect(retry.phase).toBe('video_directed');
    expect(retry.video_script).toBe(generating.video_script);
    expect(retry.video_script_approved_at).toBe(generating.video_script_approved_at);
    expect(retry.video_request_id).toBeNull();
    clock = retry.next_at + 1;
    const done = await until('complete');
    expect(done.video_script).toBe(generating.video_script);
    expect(provider.counts.videoSubmits).toBe(2);
  });

  it('preserves failed paid jobs beyond old expiry without buying replacement work', async () => {
    await paidScene();
    const previous = await getJob(bindings, id);
    await bindings.TALEMBER_DB.prepare("UPDATE creation_jobs SET phase='attention', issue='provider_response', content_expires_at=?, expires_at=? WHERE id=?")
      .bind(clock + 7 * 86_400_000, clock + 30 * 86_400_000, id).run();
    await preserveFailure(bindings, id, 'retained-failure', 422, { message: 'Synthetic failure' });
    const counts = provider.counts;
    clock += 40 * 86_400_000;
    await recover(bindings);
    const retained = await getJob(bindings, id);
    expect(retained).toMatchObject({ phase: 'attention', original_key: previous.original_key, capture_id: previous.capture_id });
    expect(retained.content_expires_at!).toBeGreaterThan(clock);
    expect(retained.expires_at).toBeGreaterThan(clock);
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(previous.original_key!)).not.toBeNull();
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(diagnosticKey(id, 'retained-failure'))).not.toBeNull();
    expect(provider.counts).toEqual(counts);
  });

  it('captures non-JSON and partial errors privately without losing earlier evidence', async () => {
    await start();
    await preserveResponse(bindings, id, 'text-error', new Response('Backend rejected https://private.invalid/x?secret=y for test@example.com',
      { status: 422, headers: { 'x-fal-error-type': 'validation_error' } }));
    const key = diagnosticKey(id, 'text-error');
    const saved = await (await bindings.TALEMBER_PRIVATE_MEDIA.get(key))!.text();
    expect(saved).toContain('Backend rejected [URL removed] for [email removed]');
    expect(saved).toContain('validation_error');
    await preserveResponse(bindings, id, 'text-error', new Response(null, { status: 422 }));
    expect(await (await bindings.TALEMBER_PRIVATE_MEDIA.get(key))!.text()).toBe(saved);
    await preserveResponse(bindings, id, 'partial-error', new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('Useful error prefix')); },
      pull(controller) { controller.error(new Error('Synthetic disconnect')); },
    }), { status: 422 }));
    const partial = await (await bindings.TALEMBER_PRIVATE_MEDIA.get(diagnosticKey(id, 'partial-error')))!.json();
    expect(partial).toMatchObject({ details: { type: 'read_failed', detail: { message: 'Useful error prefix' } } });
  });

  it('keeps completed video and diagnostics for thirty days and inputs for seven days after delivery', async () => {
    await paidScene('cartoon', 'match', undefined, 'Thank you');
    const key = diagnosticKey(id, 'synthetic-old-failure');
    await preserveFailure(bindings, id, 'synthetic-old-failure', 422, {
      detail: [{ loc: ['body', 'image_urls'], msg: 'Cannot fetch https://example.invalid/image?secret=private' }],
      input: { prompt: 'PRIVATE PROMPT', authorization: 'PRIVATE KEY' },
    });
    const retained = await (await bindings.TALEMBER_PRIVATE_MEDIA.get(key))!.text();
    expect(retained).toContain('Cannot fetch [URL removed]');
    expect(retained).not.toContain('PRIVATE');
    expect(retained).not.toContain('secret=');
    await recover(bindings);
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(key)).not.toBeNull();
    await approveVideo();
    const job = await until('complete');
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(key)).not.toBeNull();
    expect(job.next_at).toBe(0);
    const movie = provider.events.find(e => e.path === '/bytedance/seedance-2.0/reference-to-video')!;
    expect(movie.body!.prompt).toBe(job.video_script);
    expect(movie.body!.prompt).toContain('original instrumental background music');
    expect(job.closing_wish).toBe('Thank you');
    expect(job.expires_at - job.updated_at).toBe(30 * 86_400_000);
    clock = job.content_expires_at! + 1;
    expect((await request('/media/original')).status).toBe(404);
    let ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), bindings, ctx);
    await waitOnExecutionContext(ctx);
    const cleaned = await getJob(bindings, id);
    expect(cleaned.story).toBeNull();
    expect(cleaned.closing_wish).toBeNull();
    expect(cleaned.photos_json).toBeNull();
    expect(cleaned.direction_json).toBeNull();
    expect(cleaned.video_script).toBeNull();
    expect(cleaned.references_json).toBeNull();
    expect(cleaned.script_references_json).toBeNull();
    for (const n of [2, 3, 4]) expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(`creation/${id}/reference-${n}.png`)).toBeNull();
    expect(cleaned.video_script_source_key).toBeNull();
    expect(cleaned.video_script_approved_at).toBeNull();
    expect(cleaned.video_script_approved_revision).toBeNull();
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(`creation/${id}/photo-4`)).toBeNull();
    expect((await request('/media/video')).status).toBe(200);
    clock = job.expires_at + 1;
    ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), bindings, ctx);
    await waitOnExecutionContext(ctx);
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(job.video_key!)).toBeNull();
    expect(await bindings.TALEMBER_PRIVATE_MEDIA.head(key)).toBeNull();
    expect((await request('/media/video')).status).toBe(401);
    expect(
      await bindings.TALEMBER_DB.prepare(
        'SELECT count(*) AS n FROM creation_payments',
      ).first<number>('n'),
    ).toBe(1);
  });

  it('enforces disabled activation, photo/consent limits, and locale direction without making outbound calls', async () => {
    await start();
    const intake = await (await request('/create')).text();
    expect(intake).toContain('name="style"');
    expect(intake).toContain('value="realistic"');
    expect(intake).toContain('list="wish-suggestions" maxlength="80" value=""');
    for (const suggestion of ['Happy birthday', 'I love you', 'Thank you']) expect(intake).toContain(`<option value="${suggestion}">`);
    for (const invalidWish of ['x'.repeat(81), 'Two\nlines', 'Control\u0000text'])
      expect((await request('/create/checkout', checkout('cartoon', 'match', invalidWish))).status).toBe(400);
    const repeatedWish = checkout('cartoon', 'match', 'Thank you'); repeatedWish.append('closing_wish', 'I love you');
    expect((await request('/create/checkout', repeatedWish)).status).toBe(400);
    const fileWish = checkout(); fileWish.set('closing_wish', new File(['x'], 'wish.txt'));
    expect((await request('/create/checkout', fileWish)).status).toBe(400);
    expect((await request('/create')).headers.get('referrer-policy')).toBe('same-origin');
    expect((await request('/create/checkout', checkout(), { Origin: 'null' })).status).toBe(403);
    for (const [field, value] of [['style', 'storybook'], ['style', 'oil'], ['video_format', '21:9']]) {
      const forged = checkout();
      forged.set(field!, value!);
      expect((await request('/create/checkout', forged)).status).toBe(400);
      const duplicate = checkout();
      duplicate.append(field!, field === 'style' ? 'realistic' : 'horizontal');
      expect((await request('/create/checkout', duplicate)).status).toBe(400);
    }
    expect(await getJob(bindings, id)).toMatchObject({ phase: 'draft', photos_json: null, order_id: null, closing_wish: null });
    expect(videoRatio('match', 1000, 800)).toBe('4:3');
    expect(videoRatio('match', 800, 1000)).toBe('3:4');
    expect(videoRatio('match', 1000, 1000)).toBe('1:1');
    expect(videoRatio('horizontal', 720, 1280)).toBe('16:9');
    // Exercise track geometry in the existing synthetic container: fal's 720p
    // ultrawide format is 1470×630, while its 480p geometry must still fail.
    const ultrawide = video.slice();
    const geometry = new DataView(ultrawide.buffer);
    const trackType = ultrawide.findIndex((_, i) =>
      ultrawide[i] === 116 && ultrawide[i + 1] === 107 && ultrawide[i + 2] === 104 && ultrawide[i + 3] === 100);
    expect(trackType).toBeGreaterThan(4);
    const trackEnd = trackType - 4 + geometry.getUint32(trackType - 4);
    for (const [width, height, accepted] of [[1470, 630, true], [992, 432, false]] as const) {
      geometry.setUint32(trackEnd - 8, width * 65536);
      geometry.setUint32(trackEnd - 4, height * 65536);
      if (accepted) expect(() => mp4(ultrawide, '21:9')).not.toThrow();
      else expect(() => mp4(ultrawide, '21:9')).toThrow();
    }
    // Real tiny synthetic JPEG with primary TIFF orientations 6 and 8. Native
    // submissions must infer displayed orientation, not the stored pixel order.
    const jpeg = Uint8Array.from(atob('/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjI4LjEwMgD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABKAAEAAAAAAAAAAAAAAAAAAAAAAQEAAAAAAAAAAAAAAAAAAAAAEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgABAAIAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AAA//2Q=='), c => c.charCodeAt(0));
    for (const orientation of [6, 8]) {
      const exif = new Uint8Array([255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,18,1,3,0,1,0,0,0,orientation,0,0,0,0,0,0,0]);
      const rotated = await readPhoto(new File([jpeg.slice(0,2), exif, jpeg.slice(2)], 'native.jpg', { type: 'image/jpeg' }));
      expect(rotated).toMatchObject({ width: 4, height: 8 });
      expect(videoRatio('match', rotated.width, rotated.height)).toBe('9:16');
    }
    const invalid = checkout();
    invalid.delete('consent');
    expect((await request('/create/checkout', invalid)).status).toBe(400);
    const story = checkout();
    story.set('story', 'x'.repeat(801));
    expect((await request('/create/checkout', story)).status).toBe(400);
    const photo = checkout();
    photo.delete('photos');
    photo.set('photos', new File(['not-a-png'], 'fake.png', { type: 'image/png' }));
    expect((await request('/create/checkout', photo)).status).toBe(400);
    const ctx = createExecutionContext();
    const paused = await worker.fetch(
      new Request('https://talember.test/create', { headers: { Cookie: cookie } }),
      { ...bindings, TALEMBER_CREATION_ENABLED: 'false' },
      ctx,
    );
    expect(await paused.text()).toContain('disabled');
    const restricted = await worker.fetch(
      new Request('https://talember.test/create/checkout', {
        method: 'POST', headers: { Cookie: cookie, Origin: 'https://talember.test', Accept: 'application/json' }, body: checkout(),
      }),
      { ...bindings, TALEMBER_CREATION_TEST_JOB: 'a-different-creation' },
      createExecutionContext(),
    );
    expect(restricted.status).toBe(503);
    const hebrew = await (await request('/create?lang=he')).text();
    expect(hebrew).toContain('lang="he" dir="rtl"');
    expect(hebrew).toContain('name="style"');
    expect(hebrew).toContain('name="video_format" value="match" checked');
    expect(provider.events).toHaveLength(0);
  });
});
