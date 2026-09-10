import { DAY, LEASE, PRICE, enabled, paymentEnvironment, paymentReady, type Job, type Photo, type ServiceEnv, type Style, type VideoFormat } from './types';
import { videoRatio } from './media';
import { hash, ProviderError, PublicError, randomToken } from './security';
import { direct } from './director';
import { createOrder, inspectOrder, captureOrder } from './paypal';
import * as fal from './fal';
import { proposedScript, selectedSource } from './script';
import type { Locale } from './i18n';
import { FundingError } from './funding';
import { deliverAlerts } from './alerts';
import { clearDiagnostics } from './diagnostics';
import { references } from './references';
import { inspectStyle } from './style';
import { IMAGE_MODEL, referenceImage } from './openrouter-image';
import { overlayEnabled, renderGreeting } from './overlay';

// No automatic expiry while a captured purchase is awaiting delivery.
const AWAITING_DELIVERY_EXPIRY = 8640000000000000;

export async function getJob(env: ServiceEnv, id: string): Promise<Job> {
  const job = await env.TALEMBER_DB.prepare('SELECT * FROM creation_jobs WHERE id = ?')
    .bind(id)
    .first<Job>();
  if (!job) throw new PublicError(404, 'This creation has expired. Please start a new story.');
  return job;
}
export async function newJob(
  env: ServiceEnv,
  origin: string,
  token = randomToken(),
  language: Locale = 'en',
): Promise<{ job: Job; token: string }> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.TALEMBER_DB.prepare(
    "INSERT INTO creation_jobs (id, session_hash, csrf, origin, next_at, created_at, updated_at, expires_at, video_format, locale, amount, payment_environment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'match', ?, ?, ?) ON CONFLICT (session_hash) DO NOTHING",
  )
    .bind(id, await hash(token), randomToken(), origin, now, now, now, now + DAY, language, PRICE, paymentEnvironment(env))
    .run();
  const job = await env.TALEMBER_DB.prepare(
    "SELECT * FROM creation_jobs WHERE session_hash = ? AND origin = ? AND expires_at > ? AND phase != 'deleting'",
  ).bind(await hash(token), origin, now).first<Job>();
  if (!job) throw new PublicError(409, 'Please reopen your current Talember page.');
  return { job, token };
}
async function claim(env: ServiceEnv, id: string): Promise<Job | null> {
  const now = Date.now();
  return env.TALEMBER_DB.prepare(
    `UPDATE creation_jobs SET lease_token = ?, lease_until = ?
    WHERE id = ? AND lease_until <= ? AND next_at <= ? AND expires_at > ?
    AND (content_expires_at IS NULL OR content_expires_at > ?)
    AND NOT (phase = 'video_directed' AND video_script IS NOT NULL
      AND video_script_approved_at IS NULL AND video_request_id IS NULL)
    AND phase NOT IN ('draft','complete','attention','deleting') RETURNING *`,
  )
    .bind(randomToken(), now + LEASE, id, now, now, now, now)
    .first<Job>();
}
async function save(env: ServiceEnv, job: Job, delta: Partial<Job>): Promise<void> {
  const values = { lease_until: Date.now() + LEASE, ...delta, updated_at: Date.now() };
  const entries = Object.entries(values);
  const result = await env.TALEMBER_DB.prepare(
    `UPDATE creation_jobs SET ${entries.map(([k]) => `${k} = ?`).join(', ')}
    WHERE id = ? AND lease_token = ? AND lease_until > ?`,
  )
    .bind(...entries.map(([, v]) => v), job.id, job.lease_token, Date.now())
    .run();
  if (result.meta.changes !== 1) throw new ProviderError('retry');
  Object.assign(job, values);
}
export async function freeze(
  env: ServiceEnv,
  job: Job,
  story: string,
  files: { bytes: Uint8Array; type: 'image/jpeg' | 'image/png'; width: number; height: number }[],
  cast: string,
  participants: number,
  style: Style,
  format: VideoFormat,
  closingWish: string | null = null,
): Promise<void> {
  const first = files[0];
  if (!first) throw new PublicError(400, 'Choose at least one photo.');
  const ratio = videoRatio(format, first.width, first.height);
  const now = Date.now();
  const token = randomToken();
  const lock = await env.TALEMBER_DB.prepare(
    `UPDATE creation_jobs SET phase = 'uploading', lease_token = ?, lease_until = ?, updated_at = ?
    WHERE id = ? AND phase = 'draft' AND expires_at > ? RETURNING *`,
  )
    .bind(token, now + LEASE, now, job.id, now)
    .first<Job>();
  if (!lock) return; // A duplicate form submission observes the same immutable job.
  const photos: Photo[] = [];
  try {
    for (const [i, file] of files.entries()) {
      const key = `creation/${job.id}/photo-${i + 1}`;
      await env.TALEMBER_PRIVATE_MEDIA.put(key, file.bytes, {
        httpMetadata: { contentType: file.type },
      });
      photos.push({ key, type: file.type, sha256: await hash(file.bytes), width: file.width, height: file.height });
    }
    await save(env, lock, {
      story,
      closing_wish: closingWish,
      overlay_version: overlayEnabled(env) ? 1 : 0,
      cast,
      participants,
      style,
      video_format: format,
      video_ratio: ratio,
      consent_at: Date.now(),
      photos_json: JSON.stringify(photos),
      references_json: JSON.stringify(photos.slice(1).map((_, i) => ({ photo: i + 2 }))),
      snapshot_at: Date.now(),
      phase: 'ordering',
      next_at: Date.now(),
      lease_until: 0,
      lease_token: null,
    });
  } catch {
    // Deterministic keys remain owned by this row and are picked up by expiry cleanup.
    await save(env, lock, {
      phase: 'attention',
      issue: 'upload',
      lease_until: 0,
      lease_token: null,
    }).catch(() => undefined);
    throw new PublicError(503, 'We could not save your photos. Please try again later.');
  }
}
async function selectForVideo(env: ServiceEnv, job: Job): Promise<void> {
  const now = Date.now();
  const key = job.selected === 'corrected' ? job.corrected_key : job.original_key;
  if (!key || !(await env.TALEMBER_PRIVATE_MEDIA.head(key))) throw new ProviderError('invalid');
  const selected = await env.TALEMBER_DB.prepare(
    `UPDATE creation_jobs SET selected = COALESCE(selected, 'original'),
    phase = CASE WHEN json_extract(references_json, '$[0].reviewFirst') = 1 THEN 'attention'
      WHEN video_request_id IS NOT NULL THEN 'video_generating'
      WHEN video_direction_json IS NOT NULL THEN 'video_directed' ELSE 'selected' END,
    issue = CASE WHEN json_extract(references_json, '$[0].reviewFirst') = 1 THEN 'owner_preview' ELSE issue END,
    next_at = ?, updated_at = ?, lease_until = ?
    WHERE id = ? AND lease_token = ? AND lease_until > ?
    AND paid_at IS NOT NULL AND capture_id IS NOT NULL AND original_key IS NOT NULL
    AND content_expires_at > ? AND content_deleted_at IS NULL
    AND (selected IS NULL OR selected = 'original' OR (selected = 'corrected' AND corrected_key IS NOT NULL))
    RETURNING *`,
  ).bind(now, now, now + LEASE, job.id, job.lease_token, now, now).first<Job>();
  if (!selected) throw new ProviderError('invalid');
  Object.assign(job, selected);
}
async function paid(env: ServiceEnv, job: Job, capture: string): Promise<void> {
  const now = Date.now();
  const result = await env.TALEMBER_DB.batch([
    env.TALEMBER_DB.prepare(
      `INSERT INTO creation_payments (job_id, order_id, capture_id, payee_id, amount, currency, captured_at, payment_environment)
      SELECT id, order_id, ?, payee_id, amount, 'USD', ?, payment_environment FROM creation_jobs
      WHERE id = ? AND lease_token = ? AND lease_until > ? ON CONFLICT (job_id) DO NOTHING`,
    ).bind(capture, now, job.id, job.lease_token, now),
    env.TALEMBER_DB.prepare(
      `UPDATE creation_jobs SET capture_id = ?, paid_at = ?, phase = 'paid',
      content_expires_at = ?, expires_at = ?, updated_at = ? WHERE id = ? AND lease_token = ? AND lease_until > ?`,
    ).bind(capture, now, AWAITING_DELIVERY_EXPIRY, AWAITING_DELIVERY_EXPIRY, now, job.id, job.lease_token, now),
  ]);
  if (result[1]?.meta.changes !== 1) throw new ProviderError('retry');
  await env.TALEMBER_DB.prepare('UPDATE creation_payment_attempts SET capture_id = ?, checked_at = ?, issue = NULL WHERE job_id = ?')
    .bind(capture, now, job.id).run();
  Object.assign(job, {
    capture_id: capture,
    paid_at: now,
    phase: 'paid',
    content_expires_at: AWAITING_DELIVERY_EXPIRY,
    expires_at: AWAITING_DELIVERY_EXPIRY,
  });
}
async function prepareScript(env: ServiceEnv, job: Job): Promise<void> {
  const source = selectedSource(job);
  if (!source || !(await env.TALEMBER_PRIVATE_MEDIA.head(source))) throw new ProviderError('invalid');
  await save(env, job, { video_script: proposedScript(job), video_script_revision: 1,
    video_script_source_key: source, script_references_json: job.references_json });
}
async function step(env: ServiceEnv, job: Job): Promise<boolean> {
  if (job.overlay_review) return false;
  const now = Date.now();
  if (['video_directed', 'video_submitting'].includes(job.phase) && job.video_request_id) {
    await save(env, job, { phase: 'video_generating' });
    return false;
  }
  if (job.phase === 'uploading') throw new ProviderError('invalid');
  if (job.phase === 'correction_submitting' && job.correction_request_id) {
    await save(env, job, { phase: 'correction_generating' });
    return false;
  }
  if (
    [
      'directing',
      'correction_directing',
      'video_directing',
      'submitting',
      'correction_submitting',
      'video_submitting',
    ].includes(job.phase)
  ) {
    // A lease was lost during a non-idempotent external submission. Absence of an
    // ID is not proof of non-acceptance: automatic resubmission would risk spending twice.
    await save(env, job, { phase: 'attention', issue: 'submission_unknown' });
    return false;
  }
  if (job.phase === 'ordering') {
    if (job.order_started_at && now - job.order_started_at > 5 * 60 * 60 * 1000)
      throw new ProviderError('invalid');
    if (!job.order_started_at) await save(env, job, { order_started_at: now });
    const order = await createOrder(env, job);
    await save(env, job, {
      order_id: order.id,
      approval_url: order.approval,
      payee_id: order.payee,
      phase: 'awaiting_paypal',
      next_at: Date.now() + 5_000,
    });
    await rememberPayment(env, job);
    return false;
  }
  if (job.phase === 'awaiting_paypal' || job.phase === 'capturing') {
    await rememberPayment(env, job);
    const proof = await inspectOrder(env, job);
    if (proof.capture) {
      await paid(env, job, proof.capture);
      return true;
    }
    if (proof.status !== 'APPROVED') {
      if (!['CREATED', 'PAYER_ACTION_REQUIRED', 'SAVED', 'PENDING'].includes(proof.status))
        throw new ProviderError('invalid');
      await save(env, job, { next_at: Date.now() + 15_000 });
      return false;
    }
    if (job.capture_started_at && now - job.capture_started_at > 5 * 60 * 60 * 1000)
      throw new ProviderError('invalid');
    await save(env, job, { phase: 'capturing', capture_started_at: job.capture_started_at ?? now });
    // This checkpoint must succeed before the capture POST. It outlives content.
    await env.TALEMBER_DB.prepare('UPDATE creation_payment_attempts SET capture_started_at = COALESCE(capture_started_at, ?), next_at = ? WHERE job_id = ?')
      .bind(job.capture_started_at, now, job.id).run();
    await captureOrder(env, job);
    const verified = await inspectOrder(env, job);
    if (!verified.capture) {
      await save(env, job, { next_at: Date.now() + 5_000 });
      return false;
    }
    await paid(env, job, verified.capture);
    return true;
  }
  if (!job.paid_at || !job.capture_id) throw new ProviderError('invalid');
  if (job.phase === 'selected' && job.references_json !== null) {
    const rows = references(job);
    const first = rows[0];
    if (first?.styleRequired && !first.style) {
      if (first.styleStarted) {
        await save(env, job, { phase: 'attention', issue: 'submission_unknown' });
        return false;
      }
      first.styleStarted = Date.now();
      await save(env, job, { references_json: JSON.stringify(rows) });
      try { first.style = await inspectStyle(env, job); }
      catch {
        await save(env, job, { phase: 'attention', issue: 'submission_unknown' });
        return false;
      }
      await save(env, job, { references_json: JSON.stringify(rows) });
      return false;
    }
    const row = rows.find(item => !item.key);
    if (row) {
      if (row.model || (env.TALEMBER_IMAGE_PROVIDER !== 'fal' && !row.request && !row.started)) {
        if (row.started) {
          await save(env, job, { phase: 'attention', issue: 'submission_unknown' });
          return false;
        }
        row.model ??= IMAGE_MODEL;
        row.started = Date.now();
        await save(env, job, { references_json: JSON.stringify(rows) });
        try {
          const bytes = await referenceImage(env, job, row.photo, row.model);
          row.key = `creation/${job.id}/reference-${row.photo}.png`;
          await env.TALEMBER_PRIVATE_MEDIA.put(row.key, bytes, { httpMetadata: { contentType: 'image/png' } });
          await save(env, job, { references_json: JSON.stringify(rows),
            ...(row.reviewAfter ? { phase: 'attention' as const, issue: 'owner_preview' } : {}) });
        } catch {
          // An uncertain synchronous request is never automatically purchased again.
          await save(env, job, { phase: 'attention', issue: 'submission_unknown' });
        }
        return false;
      }
      if (!row.request) {
        if (row.started) throw new ProviderError('invalid');
        const body = await fal.characterBody(env, job, row.photo);
        row.started = Date.now();
        await save(env, job, { references_json: JSON.stringify(rows) });
        try { row.request = await fal.submit(env, body); }
        catch (error) {
          if (error instanceof FundingError && error.submissionRejected) {
            delete row.started;
            await save(env, job, { references_json: JSON.stringify(rows) });
            throw error;
          }
          await save(env, job, { phase: 'attention', issue: 'submission_unknown' });
          return false;
        }
        await save(env, job, { references_json: JSON.stringify(rows), next_at: Date.now() + 5000 });
        return false;
      }
      if (!row.started || Date.now() - row.started > DAY) throw new ProviderError('invalid');
      const bytes = await fal.result(env, row.request, false, job.video_ratio, job.id);
      if (!bytes) { await save(env, job, { next_at: Date.now() + 5000 }); return false; }
      row.key = `creation/${job.id}/reference-${row.photo}.png`;
      await env.TALEMBER_PRIVATE_MEDIA.put(row.key, bytes, { httpMetadata: { contentType: 'image/png' } });
      await save(env, job, { references_json: JSON.stringify(rows),
        ...(row.reviewAfter ? { phase: 'attention' as const, issue: 'owner_preview' } : {}) });
      return false;
    }
  }
  if (['ready', 'choice', 'correcting', 'correction_directed'].includes(job.phase)) {
    // Old correction intentions that were never submitted do not buy an edit.
    // A saved request identity, if present, must finish through the existing queue.
    if (job.correction_request_id && !job.corrected_key)
      await save(env, job, { phase: 'correction_generating' });
    else await selectForVideo(env, job);
    return false;
  }
  if (job.phase === 'paid' || job.phase === 'selected') {
    if (job.phase === 'paid' && env.TALEMBER_IMAGE_PROVIDER !== 'fal') {
      await save(env, job, { phase: 'directed' });
      return true;
    }
    const stage = job.phase === 'paid' ? 'image' : 'video';
    if (stage === 'video') {
      const key = job.selected === 'corrected' ? job.corrected_key : job.selected === 'original' ? job.original_key : null;
      if (!key || !(await env.TALEMBER_PRIVATE_MEDIA.head(key))) throw new ProviderError('invalid');
    }
    await save(env, job, {
      phase: stage === 'image' ? 'directing' : 'video_directing',
    });
    const directed = await direct(env, job, stage);
    await save(
      env,
      job,
      stage === 'image'
        ? {
            direction_json: JSON.stringify(directed.direction),
            direction_request_id: directed.id,
            phase: 'directed',
          }
        : {
              video_direction_json: JSON.stringify(directed.direction),
              video_direction_request_id: directed.id,
              phase: 'video_directed',
            },
    );
    if (stage === 'video') await prepareScript(env, job);
    return true;
  }
  if (job.phase === 'directed' || job.phase === 'video_directed') {
    const video = job.phase === 'video_directed';
    if (!video && env.TALEMBER_IMAGE_PROVIDER !== 'fal') {
      await save(env, job, { phase: 'submitting', submitted_at: Date.now() });
      try {
        const bytes = await referenceImage(env, job, 1, IMAGE_MODEL);
        const key = `creation/${job.id}/original.png`;
        await env.TALEMBER_PRIVATE_MEDIA.put(key, bytes, { httpMetadata: { contentType: 'image/png' } });
        await save(env, job, { original_key: key, phase: 'ready' });
        await selectForVideo(env, job);
      } catch {
        await save(env, job, { phase: 'attention', issue: 'submission_unknown' });
      }
      return false;
    }
    if (video) {
      if (job.video_script === null) await prepareScript(env, job);
      if (!job.video_script_approved_at) return false;
      if (job.video_script_approved_revision !== job.video_script_revision ||
        job.video_script_source_key !== selectedSource(job)) throw new ProviderError('invalid');
    }
    // Build and validate before the irreversible submission marker.
    const body = video
      ? await fal.videoBody(env, job)
      : await fal.submissionBody(env, job, false);
    await save(env, job, {
      phase: video ? 'video_submitting' : 'submitting',
    });
    const id = await fal.submit(env, body, video);
    await save(
      env,
      job,
      video
        ? { video_request_id: id, video_submitted_at: Date.now(), phase: 'video_generating' }
        : { request_id: id, submitted_at: Date.now(), phase: 'generating' },
    );
    return true;
  }
  if (['generating', 'correction_generating', 'video_generating'].includes(job.phase)) {
    const video = job.phase === 'video_generating';
    if (video && job.overlay_version === 1 && job.raw_video_key) {
      const bytes = await renderGreeting(env, job);
      const key = `creation/${job.id}/video.mp4`;
      await env.TALEMBER_PRIVATE_MEDIA.put(key, bytes, { httpMetadata: { contentType: 'video/mp4' } });
      await save(env, job, { video_key: key, phase: 'complete', next_at: 0,
        content_expires_at: Date.now() + 7 * DAY, expires_at: Date.now() + 30 * DAY });
      return false;
    }
    const correction = job.phase === 'correction_generating';
    const id = video
      ? job.video_request_id
      : correction
        ? job.correction_request_id
        : job.request_id;
    const started = video
      ? job.video_submitted_at
      : correction
        ? job.correction_submitted_at
        : job.submitted_at;
    if (!id || !started || Date.now() - started > DAY) throw new ProviderError('invalid');
    const bytes = await fal.result(env, id, video, job.video_ratio, job.id);
    if (!bytes) {
      await save(env, job, { next_at: Date.now() + 5_000 });
      return false;
    }
    const overlay = video && job.overlay_version === 1;
    const key = `creation/${job.id}/${video ? overlay ? 'raw-video.mp4' : 'video.mp4' : correction ? 'corrected.png' : 'original.png'}`;
    await env.TALEMBER_PRIVATE_MEDIA.put(key, bytes, {
      httpMetadata: { contentType: video ? 'video/mp4' : 'image/png' },
    });
    if (overlay) {
      await save(env, job, { raw_video_key: key, next_at: 0, overlay_review: job.closing_wish ? 1 : 0 });
      return false;
    }
    await save(
      env,
      job,
      video
        ? { video_key: key, phase: 'complete', next_at: 0, content_expires_at: Date.now() + 7 * DAY, expires_at: Date.now() + 30 * DAY }
        : correction
          ? { corrected_key: key, phase: 'choice' }
          : { original_key: key, phase: 'ready' },
    );
    if (!video) await selectForVideo(env, job);
    return false;
  }
  return false;
}
export async function progress(env: ServiceEnv, id: string): Promise<void> {
  if (!enabled(env, id)) return;
  const job = await claim(env, id);
  if (!job) return;
  try {
    if (!paymentReady(env, job.payment_environment)) return;
    // Existing sandbox orders cannot fund new live creative work after activation.
    if (job.payment_environment !== paymentEnvironment(env)) return;
    for (let i = 0; i < 6; i++) {
      const again = await step(env, job);
      if (job.issue === 'provider_balance') {
        await save(env, job, { issue: null });
        await env.TALEMBER_DB.prepare('UPDATE creation_provider_incidents SET resolved_at = ? WHERE job_id = ? AND resolved_at IS NULL')
          .bind(Date.now(), job.id).run();
      }
      if (!again) break;
      // Finish one paid network step per connected invocation; the next poll/cron
      // resumes its durable checkpoint. No paid step starts only after a response.
      if (['directed', 'correction_directed', 'video_directed', 'paid'].includes(job.phase)) break;
    }
  } catch (error) {
    if (error instanceof fal.UnchargedFailure && job.paid_at && job.capture_id) {
      if (await retryUncharged(env, job, error.requestId)) return;
    }
    if (error instanceof FundingError && job.paid_at && job.capture_id) {
      const now = Date.now();
      // Only a definitive rejected POST can rewind a submission marker.
      // Reads retain the exact acknowledged request identity.
      const phase = error.submissionRejected
        ? job.phase === 'video_submitting' ? 'video_directed'
          : job.phase === 'correction_submitting' ? 'correction_directed'
            : job.phase === 'submitting' ? 'directed' : job.phase
        : job.phase;
      await env.TALEMBER_DB.prepare(`INSERT INTO creation_provider_incidents
        (job_id,provider,detected_at,last_seen_at) VALUES (?,'fal',?,?)
        ON CONFLICT(job_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,
          notified_at=CASE WHEN resolved_at IS NOT NULL THEN NULL ELSE notified_at END,
          next_notify_at=CASE WHEN resolved_at IS NOT NULL THEN 0 ELSE next_notify_at END,
          resolved_at=NULL`)
        .bind(job.id, now, now).run();
      await save(env, job, { phase, issue: 'provider_balance', next_at: now + 5 * 60_000 });
      console.warn(JSON.stringify({ event: 'provider_balance_wait', provider: 'fal' }));
      await deliverAlerts(env);
      return;
    }
    const uncertain = [
      'directing',
      'correction_directing',
      'video_directing',
      'submitting',
      'correction_submitting',
      'video_submitting',
    ].includes(job.phase);
    const terminal =
      uncertain ||
      (error instanceof ProviderError && error.kind !== 'retry') ||
      error instanceof PublicError;
    if (terminal && ['generating', 'correction_generating', 'video_generating'].includes(job.phase))
      console.warn(JSON.stringify({ event: 'provider_result_unavailable', stage: job.phase === 'video_generating' ? 'video' : 'image' }));
    await save(
      env,
      job,
      terminal
        ? { phase: 'attention', issue: uncertain ? 'submission_unknown' : 'provider_response' }
        : { next_at: Date.now() + 15_000 },
    ).catch(() => undefined);
  } finally {
    await env.TALEMBER_DB.prepare(
      'UPDATE creation_jobs SET lease_token = NULL, lease_until = 0 WHERE id = ? AND lease_token = ?',
    )
      .bind(job.id, job.lease_token)
      .run();
  }
}
async function retryUncharged(env: ServiceEnv, job: Job, requestId: string): Promise<boolean> {
  let stage: string, delta: Partial<Job>;
  if (job.phase === 'generating' && job.request_id === requestId) {
    stage = 'image';
    delta = { phase: 'directed', request_id: null, submitted_at: null };
  } else if (job.phase === 'video_generating' && job.video_request_id === requestId &&
    job.video_script_approved_at && job.video_script_approved_revision === job.video_script_revision &&
    job.video_script_source_key === selectedSource(job)) {
    stage = 'video';
    delta = { phase: 'video_directed', video_request_id: null, video_submitted_at: null };
  } else if (job.phase === 'selected') {
    const rows = references(job);
    const row = rows.find(item => item.request === requestId && !item.key);
    if (!row) return false;
    stage = `reference-${row.photo}`;
    delete row.request; delete row.started;
    delta = { references_json: JSON.stringify(rows) };
  } else return false;
  // The job lease serializes this ledger with the state transition. Persist the
  // consumed retry budget first: a storage/state failure must not buy more work.
  const key = `diagnostics/${job.id}/retries-${stage}.json`;
  const previous = await env.TALEMBER_PRIVATE_MEDIA.get(key);
  const attempts: unknown = previous ? await previous.json() : [];
  if (!Array.isArray(attempts) || attempts.length >= 2 || attempts.some(item =>
    !item || typeof item.requestId !== 'string' || item.requestId === requestId)) return false;
  attempts.push({ requestId, billableUnits: 0, recordedAt: Date.now() });
  await env.TALEMBER_PRIVATE_MEDIA.put(key, JSON.stringify(attempts),
    { httpMetadata: { contentType: 'application/json' } });
  await save(env, job, { ...delta, issue: null, next_at: Date.now() + attempts.length * 60_000 });
  return true;
}
async function rememberPayment(env: ServiceEnv, job: Job): Promise<void> {
  await env.TALEMBER_DB.prepare(`INSERT INTO creation_payment_attempts
    (job_id, order_id, payee_id, amount, payment_environment, capture_started_at, capture_id, next_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (job_id) DO NOTHING`)
    .bind(job.id, job.order_id, job.payee_id, job.amount, job.payment_environment,
      job.capture_started_at, job.capture_id, Date.now()).run();
}

export async function cancelUnpaid(env: ServiceEnv, job: Job): Promise<void> {
  const token = randomToken();
  const locked = await env.TALEMBER_DB.prepare(`UPDATE creation_jobs SET lease_token = ?, lease_until = ?
    WHERE id = ? AND phase = 'awaiting_paypal' AND lease_until <= ? AND expires_at > ?
    AND capture_started_at IS NULL AND capture_id IS NULL AND paid_at IS NULL RETURNING *`)
    .bind(token, Date.now() + LEASE, job.id, Date.now(), Date.now()).first<Job>();
  if (!locked) throw new PublicError(409, 'Payment must be checked before editing this story.');
  try {
    await rememberPayment(env, locked);
    const proof = await inspectOrder(env, locked);
    if (proof.capture || !['CREATED', 'PAYER_ACTION_REQUIRED', 'SAVED'].includes(proof.status))
      throw new PublicError(409, 'Payment must be checked before editing this story.');
    // Stop local capture permanently; PayPal approval is not payment. Keep the
    // old immutable order and financial identity instead of reusing its amount.
    await save(env, locked, { phase: 'attention', issue: 'unpaid_cancelled' });
  } finally {
    await env.TALEMBER_DB.prepare('UPDATE creation_jobs SET lease_token = NULL, lease_until = 0 WHERE id = ? AND lease_token = ?')
      .bind(job.id, token).run();
  }
}

async function reconcilePayments(env: ServiceEnv): Promise<void> {
  const now = Date.now();
  // Reads only: after expiry never capture again or restart creative work.
  const attempts = await env.TALEMBER_DB.prepare(`SELECT job_id AS id, order_id, payee_id,
    amount, payment_environment FROM creation_payment_attempts
    WHERE capture_started_at IS NOT NULL AND capture_id IS NULL AND next_at <= ?
    AND lease_until <= ? ORDER BY next_at LIMIT 5`).bind(now, now)
    .all<Pick<Job, 'id' | 'order_id' | 'payee_id' | 'amount' | 'payment_environment'>>();
  for (const attempt of attempts.results) {
    if (!paymentReady(env, attempt.payment_environment) ||
      (env.TALEMBER_CREATION_TEST_JOB && env.TALEMBER_CREATION_TEST_JOB !== attempt.id)) continue;
    const token = randomToken();
    const lock = await env.TALEMBER_DB.prepare(`UPDATE creation_payment_attempts SET lease_token = ?, lease_until = ?
      WHERE job_id = ? AND lease_until <= ? AND capture_id IS NULL`).bind(token, Date.now() + LEASE, attempt.id, Date.now()).run();
    if (!lock.meta.changes) continue;
    try {
      const proof = await inspectOrder(env, attempt);
      if (proof.capture) {
        await env.TALEMBER_DB.batch([
          env.TALEMBER_DB.prepare(`INSERT INTO creation_payments
            (job_id, order_id, capture_id, payee_id, amount, currency, captured_at, payment_environment)
            VALUES (?, ?, ?, ?, ?, 'USD', ?, ?) ON CONFLICT (job_id) DO NOTHING`)
            .bind(attempt.id, attempt.order_id, proof.capture, attempt.payee_id, attempt.amount, Date.now(), attempt.payment_environment),
          env.TALEMBER_DB.prepare(`UPDATE creation_payment_attempts SET capture_id = ?, checked_at = ?,
            issue = CASE WHEN EXISTS (SELECT 1 FROM creation_jobs WHERE id = ? AND expires_at > ?
              AND (content_expires_at IS NULL OR content_expires_at > ?) AND content_deleted_at IS NULL)
              THEN NULL ELSE 'captured_content_expired' END WHERE job_id = ? AND lease_token = ?`)
            .bind(proof.capture, Date.now(), attempt.id, Date.now(), Date.now(), attempt.id, token),
        ]);
      } else {
        await env.TALEMBER_DB.prepare(`UPDATE creation_payment_attempts SET checked_at = ?, issue = 'capture_unresolved'
          WHERE job_id = ? AND lease_token = ?`).bind(Date.now(), attempt.id, token).run();
      }
    } catch {
      await env.TALEMBER_DB.prepare(`UPDATE creation_payment_attempts SET issue = 'reconciliation_unavailable'
        WHERE job_id = ? AND lease_token = ?`).bind(attempt.id, token).run();
    } finally {
      await env.TALEMBER_DB.prepare(`UPDATE creation_payment_attempts SET lease_token = NULL, lease_until = 0,
        next_at = ? WHERE job_id = ? AND lease_token = ?`).bind(Date.now() + 5 * 60_000, attempt.id, token).run();
    }
  }
}

export async function recover(env: ServiceEnv): Promise<void> {
  // Upgrade existing unfinished paid rows before any expiry or recovery scan.
  // Never revive already deleted content or change provider submission identities.
  await env.TALEMBER_DB.prepare(`UPDATE creation_jobs SET content_expires_at=?, expires_at=?
    WHERE capture_id IS NOT NULL AND paid_at IS NOT NULL
    AND phase NOT IN ('complete', 'deleting') AND content_deleted_at IS NULL
    AND (content_expires_at IS NULL OR content_expires_at != ? OR expires_at != ?)`)
    .bind(AWAITING_DELIVERY_EXPIRY, AWAITING_DELIVERY_EXPIRY, AWAITING_DELIVERY_EXPIRY, AWAITING_DELIVERY_EXPIRY).run();
  // Prioritize acknowledged provider work before slower cleanup and financial reads.
  const due = await env.TALEMBER_DB.prepare(
    `SELECT id FROM creation_jobs WHERE next_at <= ? AND lease_until <= ? AND expires_at > ?
    AND NOT (phase = 'video_directed' AND video_script IS NOT NULL
      AND video_script_approved_at IS NULL AND video_request_id IS NULL)
    AND phase NOT IN ('draft','complete','attention','deleting') AND overlay_review = 0
    ORDER BY CASE WHEN phase IN ('generating','correction_generating','video_generating') THEN 0 ELSE 1 END,
    next_at LIMIT 60`,
  ).bind(Date.now(), Date.now(), Date.now()).all<{ id: string }>();
  const deadline = Date.now() + 4 * 60_000;
  let completed = 0;
  // One bounded media buffer at a time: parallel 64 MiB video downloads could
  // exceed Worker memory. Priority plus five-minute runs provides retry margin.
  for (const candidate of due.results) {
    if (Date.now() >= deadline) break;
    await progress(env, candidate.id);
    completed++;
  }
  if (due.results.length === 60 || completed < due.results.length)
    console.warn(JSON.stringify({ event: 'recovery_backlog', due: due.results.length, processed: completed }));
  await reconcilePayments(env);
  const cleanupToken = randomToken();
  const oldContent = await env.TALEMBER_DB.prepare(
    `UPDATE creation_jobs SET lease_token = ?, lease_until = ?,
    phase = CASE WHEN phase = 'complete' THEN phase ELSE 'attention' END,
    issue = CASE WHEN phase = 'complete' THEN issue ELSE 'content_expired' END
    WHERE id IN (SELECT id FROM creation_jobs WHERE content_expires_at <= ? AND content_deleted_at IS NULL
    AND lease_until <= ? LIMIT 30) RETURNING id`,
  )
    .bind(cleanupToken, Date.now() + LEASE, Date.now(), Date.now())
    .all<{ id: string }>();
  for (const { id } of oldContent.results) {
    // Deny source/scene access as soon as content_expires_at passes, then erase the
    // bounded deterministic object set. Final video and minimal receipt remain.
    await env.TALEMBER_PRIVATE_MEDIA.delete(
      ['photo-1', 'photo-2', 'photo-3', 'photo-4', 'original.png', 'corrected.png', 'reference-2.png', 'reference-3.png', 'reference-4.png', 'raw-video.mp4'].map(
        (n) => `creation/${id}/${n}`,
      ),
    );
    await env.TALEMBER_DB.prepare(
      `UPDATE creation_jobs SET story = NULL, closing_wish = NULL, cast = NULL, photos_json = NULL,
      direction_json = NULL, correction = NULL, correction_direction_json = NULL, video_direction_json = NULL,
      video_script = NULL, video_script_source_key = NULL, video_script_revision = 0, references_json = NULL, script_references_json = NULL,
      video_script_approved_at = NULL, video_script_approved_revision = NULL,
      original_key = NULL, corrected_key = NULL, raw_video_key = NULL, content_deleted_at = ?, lease_until = 0, lease_token = NULL
      WHERE id = ? AND lease_token = ?`,
    )
      .bind(Date.now(), id, cleanupToken)
      .run();
  }
  // Mark expiry before deleting objects so concurrent media requests fail closed.
  const expired = await env.TALEMBER_DB.prepare(
    `UPDATE creation_jobs SET phase = 'deleting', lease_token = NULL, lease_until = 0
    WHERE id IN (SELECT id FROM creation_jobs WHERE expires_at <= ? AND lease_until <= ? ORDER BY expires_at LIMIT 30) RETURNING id`,
  )
    .bind(Date.now(), Date.now())
    .all<{ id: string }>();
  for (const { id } of expired.results) {
    if (!await clearDiagnostics(env, id)) continue;
    const keys = [
      'photo-1',
      'photo-2',
      'photo-3',
      'photo-4',
      'original.png',
      'corrected.png',
      'video.mp4',
      'raw-video.mp4',
      'reference-2.png', 'reference-3.png', 'reference-4.png',
    ].map((name) => `creation/${id}/${name}`);
    await env.TALEMBER_PRIVATE_MEDIA.delete(keys);
    await env.TALEMBER_DB.prepare("DELETE FROM creation_jobs WHERE id = ? AND phase = 'deleting'")
      .bind(id)
      .run();
  }
}
