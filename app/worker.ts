import { displayPhase, enabled, MAX_CLOSING_WISH, type Job, type ServiceEnv } from './types';
import {
  csrf,
  form,
  nextSessionToken,
  ownedJob,
  PublicError,
  renewCookie,
  safe,
  sameOrigin,
  sessionCookie,
  textField,
} from './security';
import { cancelUnpaid, freeze, getJob, newJob, progress, recover } from './jobs';
import { home, page, panel, information } from './page';
import { copy, locale } from './i18n';
import { photo } from './media';
import { reviewScript } from './script';
import { deliverAlerts } from './alerts';
import { placementAction, greetingPreview } from './placement';

function errorText(error: unknown, language: ReturnType<typeof locale>): string {
  const t = copy(language);
  if (!(error instanceof PublicError)) return t.unexpectedError;
  const message = error.message;
  if (message.includes('Payment must be checked')) return t.paymentCheck;
  if (message.includes('PayPal return')) return t.paymentMismatch;
  if (error.status === 401 || error.status === 403 || /reopen|return to|Return using|browser where/i.test(message)) return t.sessionError;
  if (message.includes('1–4 adults')) return t.consentError;
  if (/photo|image|file|upload/i.test(message) && !message.includes('expired')) return t.uploadError;
  if (message.includes('expired')) return t.expired;
  if (message === 'Checkout is temporarily unavailable.') return t.paused;
  if (message === 'Not found.') return t.sessionError;
  if (/^Describe |form/.test(message)) return t.error;
  return message;
}
function redirect(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path } });
}
function state(job: Job, env: ServiceEnv, request: Request): Response {
  const cookie = renewCookie(request);
  return Response.json(
    {
      phase: displayPhase(job),
      html: panel(job, env),
      scriptRevision: job.video_script_revision,
      approval: job.phase === 'awaiting_paypal' ? job.approval_url : null,
    },
    { headers: cookie ? { 'Set-Cookie': cookie } : {} },
  );
}
async function run(env: ServiceEnv, job: Job, ctx: ExecutionContext): Promise<Job> {
  // Keep the request open for the stage timeout; waitUntil additionally protects
  // the final checkpoint for up to 30 seconds after a client disconnects.
  const pending = progress(env, job.id);
  ctx.waitUntil(pending);
  await pending;
  return getJob(env, job.id);
}
async function media(request: Request, env: ServiceEnv, job: Job, kind: string): Promise<Response> {
  if (kind === 'greeting') return greetingPreview(env,job);
  if (kind !== 'original' && kind !== 'corrected' && kind !== 'video' && kind !== 'raw')
    throw new PublicError(404, 'Not found.');
  if (kind !== 'video' && job.content_expires_at && job.content_expires_at <= Date.now())
    throw new PublicError(404, 'This image has expired.');
  const key =
    kind === 'raw' ? job.raw_video_key : kind === 'video' ? job.video_key : kind === 'original' ? job.original_key : job.corrected_key;
  if (!key) throw new PublicError(404, 'Not found.');
  const metadata = await env.TALEMBER_PRIVATE_MEDIA.head(key);
  if (!metadata) throw new PublicError(404, 'Not found.');
  const headers = new Headers({
    'Content-Type': kind === 'video' || kind === 'raw' ? 'video/mp4' : 'image/png',
    'Accept-Ranges': 'bytes',
  });
  const range = request.headers.get('range');
  let offset = 0;
  let end = metadata.size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}` },
      });
    if (match[1]) {
      offset = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), end) : end;
    } else offset = Math.max(0, metadata.size - Number(match[2]));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(end) ||
      offset < 0 ||
      offset > end ||
      offset >= metadata.size
    ) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${metadata.size}` },
      });
    }
    headers.set('Content-Range', `bytes ${offset}-${end}/${metadata.size}`);
  }
  headers.set('Content-Length', String(end - offset + 1));
  if (new URL(request.url).searchParams.get('download') === '1')
    headers.set(
      'Content-Disposition',
      `attachment; filename="talember-${kind === 'video' ? 'story.mp4' : `${kind}.png`}"`,
    );
  if (request.method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers });
  const object = await env.TALEMBER_PRIVATE_MEDIA.get(key, {
    range: { offset, length: end - offset + 1 },
  });
  if (!object) throw new PublicError(404, 'Not found.');
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
async function route(request: Request, env: ServiceEnv, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method === 'GET' &&
    (url.pathname.startsWith('/assets/brand/') ||
      url.pathname === '/assets/preview/demo.mp4' ||
      url.pathname === '/assets/preview/placeholder.svg' ||
      url.pathname === '/assets/styles/cartoon-v1.svg' ||
      url.pathname === '/assets/styles/realism-v1.svg' ||
      url.pathname === '/styles/service.css' ||
      url.pathname === '/scripts/service.js')
  ) {
    return env.ASSETS.fetch(request);
  }
  if (request.method === 'GET' && ['/support', '/privacy', '/refunds'].includes(url.pathname)) {
    return new Response(information(url.pathname.slice(1) as 'support' | 'privacy' | 'refunds', locale(url.searchParams.get('lang')), env),
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  let job = await ownedJob(request, env);
  if (url.pathname === '/' && request.method === 'GET') {
    const cookie = renewCookie(request);
    return new Response(home(job, locale(url.searchParams.get('lang') ?? job?.locale ?? 'en'), true, env), {
      headers: { 'Content-Type': 'text/html; charset=utf-8', ...(cookie ? { 'Set-Cookie': cookie } : {}) },
    });
  }
  if (request.method === 'GET' && url.pathname === '/create') {
    let setCookie: string | undefined = renewCookie(request) ?? undefined;
    if (!job) {
      if (url.searchParams.has('payment'))
        throw new PublicError(401, 'Return using the browser where you started your story.');
      const created = await newJob(env, url.origin);
      job = created.job;
      setCookie = sessionCookie(request, created.token);
    }
    if (url.searchParams.has('lang')) {
      const language = locale(url.searchParams.get('lang'));
      await env.TALEMBER_DB.prepare('UPDATE creation_jobs SET locale = ? WHERE id = ?')
        .bind(language, job.id)
        .run();
      job.locale = language;
    }
    if (url.searchParams.get('payment') === 'return') {
      // This is a wake-up hint only. Even a correct token is never proof of payment.
      if (url.searchParams.get('token') !== job.order_id || !job.order_id)
        throw new PublicError(400, 'This PayPal return does not match your story.');
      await env.TALEMBER_DB.prepare(
        "UPDATE creation_jobs SET next_at = ?, phase = 'capturing' WHERE id = ? AND phase IN ('awaiting_paypal','capturing')",
      )
        .bind(Date.now(), job.id)
        .run();
      return redirect('/create');
    }
    if (url.searchParams.get('payment') === 'cancel') return redirect('/create');
    if (url.searchParams.get('advance') === '1') job = await run(env, job, ctx);
    return new Response(page(job, env, '', undefined, url.searchParams.get('saved') === '1'), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
      },
    });
  }
  if (!job)
    throw new PublicError(401, 'Please open your Talember page in the browser where you started.');
  if (url.pathname === '/api/job' && request.method === 'GET')
    return state(url.searchParams.get('inspect') === '1' ? job : await run(env, job, ctx), env, request);
  if (url.pathname.startsWith('/media/') && (request.method === 'GET' || request.method === 'HEAD'))
    return media(request, env, job, url.pathname.slice(7));
  if (
    request.method !== 'POST' ||
    !['/create/checkout', '/create/script', '/create/placement', '/create/improve', '/create/choose', '/create/new', '/create/edit'].includes(url.pathname)
  )
    throw new PublicError(404, 'Not found.');
  sameOrigin(request);
  if (env.TALEMBER_PUBLIC_ORIGIN !== url.origin || job.origin !== url.origin)
    throw new PublicError(503, 'Checkout is temporarily unavailable.');
  if (url.pathname === '/create/edit') {
    const data = await form(request, 4096);
    csrf(job, data.get('csrf'));
    if (!(job.phase === 'attention' && job.issue === 'unpaid_cancelled')) await cancelUnpaid(env, job);
    const created = await newJob(env, url.origin, await nextSessionToken(request, job), job.locale);
    await env.TALEMBER_DB.prepare(`UPDATE creation_jobs SET amount = ?, story = ?, cast = ?,
      closing_wish = ?, participants = ?, video_format = ?, payment_environment = ?, style = ?
      WHERE id = ? AND phase = 'draft' AND snapshot_at IS NULL`)
      .bind(job.amount, job.story, job.cast, job.closing_wish, job.participants, job.video_format,
        job.payment_environment, job.style, created.job.id).run();
    return new Response(null, { status: 303, headers: {
      Location: '/create?edited=1', 'Set-Cookie': sessionCookie(request, created.token),
    } });
  }
  if (url.pathname === '/create/new') {
    const data = await form(request, 4096);
    csrf(job, data.get('csrf'));
    if (data.getAll('confirmation').length !== 1 || data.get('confirmation') !== 'saved')
      throw new PublicError(400, copy(job.locale).newConfirmHint);
    if (job.phase !== 'complete' || !job.video_key || !(await env.TALEMBER_PRIVATE_MEDIA.head(job.video_key)))
      throw new PublicError(409, copy(job.locale).resume);
    const created = await newJob(env, url.origin, await nextSessionToken(request, job), locale(url.searchParams.get('lang') ?? job.locale));
    // This is navigation only. Keep old media/receipts on their normal expiry,
    // and never run payment/provider work or widen exact-job staging activation.
    return new Response(null, { status: 303, headers: {
      Location: `/?lang=${created.job.locale}`, 'Set-Cookie': sessionCookie(request, created.token),
    } });
  }
  if (job.content_expires_at && job.content_expires_at <= Date.now())
    throw new PublicError(410, 'The photos and scenes for this story have expired.');
  const data = await form(request, url.pathname === '/create/checkout' ? 11 * 1024 * 1024 : url.pathname === '/create/script' ? 65_536 : 16_384);
  if(url.pathname === '/create/placement') {
    csrf(job,data.get('csrf'));
    job=await placementAction(env,job,data);
    return request.headers.get('accept')?.includes('application/json') ? state(job,env,request) : redirect('/create');
  }
  if (url.pathname === '/create/script') {
    const script = data.get('script');
    const revision = data.get('revision');
    try {
      csrf(job, data.get('csrf'));
      const intent = data.get('intent');
      if (data.getAll('script').length !== 1 || typeof script !== 'string' ||
        data.getAll('revision').length !== 1 || typeof revision !== 'string' || !/^[1-9]\d{0,8}$/.test(revision) ||
        data.getAll('intent').length !== 1 || (intent !== 'save' && intent !== 'approve'))
        throw new PublicError(400, copy(job.locale).scriptInvalid);
      if (intent === 'approve' && !enabled(env, job.id, job.payment_environment))
        throw new PublicError(503, copy(job.locale).paused);
      const greeting = data.get('greeting');
      const effect = data.get('effect');
      const color = data.get('color');
      const font = data.get('font');
      if (data.getAll('font').length > 1 || (font !== null && typeof font !== 'string'))
        throw new PublicError(400, copy(job.locale).scriptInvalid);
      if (data.getAll('color').length > 1 || (color !== null && typeof color !== 'string'))
        throw new PublicError(400, copy(job.locale).scriptInvalid);
      if (data.getAll('effect').length > 1 || (effect !== null && typeof effect !== 'string'))
        throw new PublicError(400, copy(job.locale).scriptInvalid);
      if (job.overlay_version === 1 && (data.getAll('greeting').length !== 1 || typeof greeting !== 'string'))
        throw new PublicError(400, copy(job.locale).scriptInvalid);
      job = await reviewScript(env, job, script, Number(revision), intent === 'approve',
        job.overlay_version === 1 ? greeting as string : job.closing_wish, typeof effect === 'string' ? effect : 'none', typeof color === 'string' ? color : 'white', typeof font === 'string' ? font : 'classic');
      // Approval is a durable checkpoint. The next connected poll or scheduled
      // recovery submits it; saving a draft never starts a provider request.
      return request.headers.get('accept')?.includes('application/json')
        ? state(job, env, request) : redirect(intent === 'save' ? '/create?saved=1' : '/create');
    } catch (error) {
      if (request.headers.get('accept')?.includes('application/json')) throw error;
      const current = await getJob(env, job.id);
      return new Response(page(current, env,
        errorText(error, job.locale),
        typeof script === 'string' && typeof revision === 'string' ? { text: script, revision,
          greeting: typeof data.get('greeting') === 'string' ? data.get('greeting') as string : undefined,
          effect: typeof data.get('effect') === 'string' ? data.get('effect') as string : undefined,
          color: typeof data.get('color') === 'string' ? data.get('color') as string : undefined,
          font: typeof data.get('font') === 'string' ? data.get('font') as string : undefined } : undefined),
      { status: error instanceof PublicError ? error.status : 503,
        headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
  }
  csrf(job, data.get('csrf'));
  if (!enabled(env, job.id, job.payment_environment)) throw new PublicError(503, copy(job.locale).paused);
  if (url.pathname !== '/create/checkout')
    throw new PublicError(410, copy(job.locale).automaticNotice);
  if (url.pathname === '/create/checkout') {
    if (job.phase === 'draft') {
      const styles = data.getAll('style');
      const style = styles[0] ?? 'cartoon';
      if (styles.length > 1 || (style !== 'cartoon' && style !== 'realistic'))
        throw new PublicError(400, copy(job.locale).styleInvalid);
      const formats = data.getAll('video_format');
      const format = formats[0] ?? job.video_format;
      if (formats.length > 1 || (format !== 'match' && format !== 'vertical' && format !== 'horizontal'))
        throw new PublicError(400, copy(job.locale).formatInvalid);
      const story = textField(data, 'story', 10, 800);
      const wishes = data.getAll('closing_wish');
      const wish = wishes[0] ?? '';
      if (wishes.length > 1 || typeof wish !== 'string' || wish.length > MAX_CLOSING_WISH ||
        [...wish].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
        throw new PublicError(400, copy(job.locale).wishInvalid);
      const closingWish = wish.trim() || null;
      const cast = textField(data, 'cast', 2, 400);
      const participants = Number(data.get('participants'));
      if (
        !Number.isInteger(participants) ||
        participants < 1 ||
        participants > 4 ||
        data.get('consent') !== 'yes'
      ) {
        throw new PublicError(
          400,
          'Choose 1–4 adults or pets and confirm that you have permission to use their photos.',
        );
      }
      const files = data.getAll('photos');
      if (
        files.length < 1 ||
        files.length > 4 ||
        files.some((f) => !(f instanceof File) || !f.size) ||
        files.reduce((size, f) => size + (f instanceof File ? f.size : 0), 0) > 10 * 1024 * 1024
      ) {
        throw new PublicError(
          400,
          'Choose 1–4 JPG or PNG photos, up to 5 MB each and 10 MB in total.',
        );
      }
      const validated = [];
      for (const file of files) validated.push(await photo(file as File));
      await freeze(env, job, story, validated, cast, participants, style, format, closingWish);
    }
  }
  job = await run(env, job, ctx);
  return request.headers.get('accept')?.includes('application/json')
    ? state(job, env, request)
    : redirect(job.phase === 'awaiting_paypal' ? job.approval_url! : '/create');
}
export default {
  async fetch(request: Request, env: ServiceEnv, ctx: ExecutionContext): Promise<Response> {
    try {
      return safe(await route(request, env, ctx));
    } catch (error) {
      const status = error instanceof PublicError ? error.status : 503;
      const job = await ownedJob(request, env).catch(() => null);
      const language = locale(new URL(request.url).searchParams.get('lang') ?? job?.locale ?? 'en');
      const message = errorText(error, language);
      if (request.headers.get('accept')?.includes('application/json'))
        return safe(Response.json({ error: message }, { status }));
      return safe(
        new Response(job ? page(job, env, message) : message, {
          status,
          headers: {
            'Content-Type': job ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
          },
        }),
      );
    }
  },
  async scheduled(
    _event: ScheduledController,
    env: ServiceEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    const work = (async () => {
      await recover(env);
      await deliverAlerts(env);
      await env.TALEMBER_DB.prepare('DELETE FROM creation_provider_incidents WHERE last_seen_at < ?')
        .bind(Date.now() - 30 * 86400_000).run();
    })();
    ctx.waitUntil(work);
    await work;
  },
} satisfies ExportedHandler<ServiceEnv>;
