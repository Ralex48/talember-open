import { deflateSync } from 'node:zlib';

// Synthetic media only: colored blocks, no customer photographs or previous fixtures.
export function syntheticPng(corrected = false, width = 720, height = 1280): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * (width * 3 + 1) + 1 + x * 3;
      const foreground = x > 170 && x < 550 && y > 340 && y < 990;
      raw[i] = foreground ? (corrected ? 210 : 185) : 53;
      raw[i + 1] = foreground ? 143 : 91;
      raw[i + 2] = foreground ? 80 : corrected ? 137 : 116;
    }
  const crc = (bytes: Uint8Array): number => {
    let value = 0xffffffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let i = 0; i < 8; i++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(data.length + 12);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, data.length);
    bytes.set(new TextEncoder().encode(type), 4);
    bytes.set(data, 8);
    view.setUint32(bytes.length - 4, crc(bytes.subarray(4, bytes.length - 4)));
    return bytes;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const gamma = new Uint8Array(4);
  new DataView(gamma.buffer).setUint32(0, 45455);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('sRGB', new Uint8Array([0])),
    chunk('gAMA', gamma),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array()),
  ];
  const result = new Uint8Array(parts.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

interface Order {
  id: string;
  job: string;
  captured: boolean;
  request: string;
  amount: string;
}
export interface FixtureOptions {
  paymentEnvironment?: 'sandbox' | 'live';
  video: Uint8Array;
  verticalVideo?: Uint8Array;
  imageSize?: { width: number; height: number };
  advance?: (ms: number) => void;
  now?: () => number;
  autoApprove?: boolean;
}
export function createProviderFixture(options: FixtureOptions) {
  const initial = syntheticPng(false, options.imageSize?.width, options.imageSize?.height);
  const corrected = syntheticPng(true, options.imageSize?.width, options.imageSize?.height);
  const orders = new Map<string, Order>();
  const uploads = new Map<string, Uint8Array | null>();
  let untrustedUpload = false;
  let untrustedSignedUrl = false;
  let corruptSignedRead = false;
  const requests = new Map<
    string,
    { video: boolean; ratio?: string; corrected: boolean; pendingStatuses: string[] }
  >();
  const events: {
    method: string;
    host: string;
    path: string;
    body: Record<string, unknown> | null;
  }[] = [];
  let approved = options.autoApprove ?? false;
  let imageSubmits = 0;
  let videoSubmits = 0;
  let directionCalls = 0;
  let capturePosts = 0;
  let loseSubmission = false;
  let failDownload = false;
  let untrustedDownloadGrant = false;
  let badPayment: 'order' | 'capture' | null = null;
  let loseOrderResponse = false;
  let loseCaptureResponse = false;
  let failDirection = false;
  let capturePending = false;
  let queueNext = false;
  let retrievalFailure: { location: 'status' | 'result'; bound: false | 'request' | 'type'; status: 404 | 422 | 504; units?: string } | undefined;
  let completedError: 'error' | 'error_type' | undefined;
  let canceledErrorBodies = 0;
  let readErrorBodies = 0;
  let rejectErrorCancellation = false;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const now = options.now ?? Date.now;
  const orderBody = (order: Order) => ({
    id: order.id,
    intent: 'CAPTURE',
    status: order.captured ? 'COMPLETED' : approved ? 'APPROVED' : 'CREATED',
    purchase_units: [
      {
        reference_id: order.job,
        custom_id: order.job,
        amount: { currency_code: 'USD', value: badPayment === 'order' ? '0.01' : order.amount },
        payee: { merchant_id: 'SYNTHETICMERCHANT' },
        ...(order.captured
          ? {
              payments: {
                captures: [
                  {
                    id: `CAP${order.id}`,
                    status: capturePending ? 'PENDING' : 'COMPLETED',
                    final_capture: true,
                    amount: { currency_code: 'USD', value: badPayment === 'capture' ? '0.01' : order.amount },
                  },
                ],
              },
            }
          : {}),
      },
    ],
    links: [
      {
        rel: 'payer-action',
        method: 'GET',
        href: `https://${options.paymentEnvironment === 'live' ? 'www.paypal.com' : 'www.sandbox.paypal.com'}/checkoutnow?token=${order.id}`,
      },
    ],
  });
  return {
    initial,
    corrected,
    events,
    uploaded(url: string) { return uploads.get(new URL(url).pathname); },
    untrustedNextUpload() { untrustedUpload = true; },
    untrustedNextSignedUrl() { untrustedSignedUrl = true; },
    corruptNextSignedRead() { corruptSignedRead = true; },
    get counts() {
      return { orders: orders.size, imageSubmits, videoSubmits, directionCalls, capturePosts };
    },
    get errorBodies() {
      return { canceled: canceledErrorBodies, read: readErrorBodies };
    },
    failNextRetrieval(location: 'status' | 'result', bound: false | 'request' | 'type' = false, status: 404 | 504 = 504) {
      retrievalFailure = { location, bound, status };
    },
    failNextWithBilling(units?: string) {
      retrievalFailure = { location: 'result', bound: 'request', status: 422, units };
    },
    rejectNextErrorCancellation() {
      rejectErrorCancellation = true;
    },
    failNextCompletedStatus(field: 'error' | 'error_type') {
      completedError = field;
    },
    approve() {
      approved = true;
    },
    loseNextSubmission() {
      loseSubmission = true;
    },
    queueNextRequest() {
      queueNext = true;
    },
    restoreCorrection() {
      // Represent a provider request already purchased before edits were retired.
      imageSubmits++;
      directionCalls++;
      const id = `synthetic-image-${imageSubmits}`;
      requests.set(id, { video: false, corrected: true, pendingStatuses: ['IN_QUEUE', 'IN_PROGRESS'] });
      return { id, directionId: `gen-legacy-correction-${directionCalls}` };
    },
    failNextDownload() {
      failDownload = true;
    },
    untrustedNextDownloadGrant() {
      untrustedDownloadGrant = true;
    },
    tamperPayment(kind: 'order' | 'capture' | null = 'order') {
      badPayment = kind;
    },
    loseNextOrderResponse() {
      loseOrderResponse = true;
    },
    loseNextCaptureResponse() { loseCaptureResponse = true; },
    pendingCapture(value: boolean) {
      capturePending = value;
    },
    failNextDirection() {
      failDirection = true;
    },
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);
      const method = request.method;
      const binary = method === 'PUT' ? new Uint8Array(await request.arrayBuffer()) : null;
      const raw = request.headers.get('content-type')?.includes('application/json')
        ? await request.text()
        : '';
      if (!raw && !binary) await request.body?.cancel();
      let body: Record<string, unknown> | null = null;
      if (raw.startsWith('{')) body = JSON.parse(raw);
      events.push({ method, host: url.host, path: url.pathname + url.search, body });
      options.advance?.(url.host === 'openrouter.ai' ? 35_000 : 1500);
      if (url.host === (options.paymentEnvironment === 'live' ? 'api-m.paypal.com' : 'api-m.sandbox.paypal.com')) {
        if (!request.headers.has('authorization'))
          throw new Error('Synthetic PayPal requires authorization.');
        if (url.pathname === '/v1/oauth2/token')
          return json({ access_token: 'synthetic-access-token', token_type: 'Bearer' });
        if (url.pathname === '/v2/checkout/orders' && method === 'POST') {
          const key = request.headers.get('paypal-request-id')!;
          const unit = (body!.purchase_units as { reference_id: string; amount: { currency_code: string; value: string } }[])[0]!;
          const job = unit.reference_id;
          const amount = unit.amount.value;
          if (key !== `create-${job}` || unit.amount.currency_code !== 'USD' || !['9.99', '14.99', '19.99'].includes(amount))
            throw new Error('Invalid synthetic order amount or identity.');
          const old = [...orders.values()].find((order) => order.request === key);
          if (old) {
            if (old.job !== job || old.amount !== amount) throw new Error('Replayed order changed its frozen amount.');
            return json(orderBody(old));
          }
          const order = { id: `SYNTHETIC${orders.size + 1}`, job, captured: false, request: key, amount };
          orders.set(order.id, order);
          if (loseOrderResponse) {
            loseOrderResponse = false;
            throw new Error('Synthetic lost order acknowledgment.');
          }
          return json(orderBody(order), 201);
        }
        const match = /^\/v2\/checkout\/orders\/(SYNTHETIC\d+)(\/capture)?$/.exec(url.pathname);
        if (match) {
          const order = orders.get(match[1]!)!;
          if (match[2]) {
            if (!approved || request.headers.get('paypal-request-id') !== `capture-${order.job}`)
              throw new Error('Unapproved or non-idempotent capture.');
            capturePosts++;
            order.captured = true;
            if (loseCaptureResponse) {
              loseCaptureResponse = false;
              throw new Error('Synthetic lost capture response.');
            }
          }
          return json(orderBody(order));
        }
      }
      if (url.origin === 'https://openrouter.ai' && url.pathname === '/api/v1/chat/completions') {
        if (![...orders.values()].some((o) => o.captured))
          throw new Error('Direction before captured payment.');
        directionCalls++;
        if ((body!.response_format as { json_schema?: { name?: string } }).json_schema?.name === 'talember_rendering_style') {
          return json({ id: `gen-synthetic-style-${directionCalls}`, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ description: 'Thin warm brown contours, simplified expressive faces, flat muted ochre and olive colors, minimal soft cel shading and no photographic skin texture.' }) } }] });
        }
        if (failDirection) {
          failDirection = false;
          throw new Error('Synthetic lost director response.');
        }
        const content = (body!.messages as { content: string | { type: string; text?: string; image_url?: { url: string } }[] }[])[1]!.content;
        const user = JSON.parse(typeof content === 'string' ? content : content[0]!.text!);
        const selection = Object.hasOwn(user, 'memory');
        if (selection ? typeof content !== 'string' : !Array.isArray(content) ||
          content.length < 2 || content.length > 5 || content[0]!.type !== 'text' || content[1]!.type !== 'image_url' ||
          !content[1]!.image_url?.url.startsWith('data:image/png;base64,'))
          throw new Error('Expected unchanged text selection or exactly one private vision image.');
        return json({
          id: `gen-synthetic-${directionCalls}`,
          choices: [
            {
              finish_reason: 'stop',
              message: {
                role: 'assistant',
                content: JSON.stringify(
                  selection
                    ? user.correction === null
                      ? { framing: 'balanced', palette: 'soft' }
                      : { framing: 'closer', palette: 'warm' }
                    : {
                        style: `Preserve the reference ${user.style} rendering.`,
                        subjects: 'Keep the visible subjects and their appearance continuous.',
                        environment: 'Keep the visible background and existing light.',
                        action: `0–5s establish the action: ${user.story} 5–10s continue naturally. ${user.closing_wish ? '10–12s settle into the ending. 12–15s hold clear space away from faces for the closing wish supplied separately.' : '10–15s settle into the ending.'}`,
                        camera:
                          'Keep every subject in frame, use padding for the requested format and gentle camera movement.',
                        audio: String(user.story).includes('No background music.')
                          ? 'Soft natural ambience. No background music, vocals or dialogue.'
                          : 'Subtle original instrumental background music matching the story’s mood and pace, alongside soft natural ambience. No vocals or dialogue.',
                        reference_ids: user.references,
                      },
                ),
              },
            },
          ],
        });
      }
      if (url.origin === 'https://queue.fal.run') {
        if (method === 'POST') {
          if (![...orders.values()].some((o) => o.captured))
            throw new Error('Generation before captured payment.');
          const video = url.pathname === '/bytedance/seedance-2.0/reference-to-video';
          const life = JSON.parse(request.headers.get('x-fal-object-lifecycle-preference')!);
          if (
            (video ? JSON.stringify(life) !== '{"expiration_duration_seconds":3600}'
              : life.initial_acl?.default !== 'forbid' || JSON.stringify(life.initial_acl.rules) !== '[]') ||
            life.expiration_duration_seconds !== 3600 ||
            request.headers.get('x-fal-store-io') !== '0' ||
            request.headers.has('x-fal-no-retry') ||
            request.headers.get('x-fal-request-timeout') !== '600' ||
            request.headers.get('x-app-fal-disable-fallback') !== 'true'
          )
            throw new Error('Missing privacy or bounded same-request retry settings.');
          if (video) {
            const images = body!.image_urls as string[];
            const image = new URL(images[0]!);
            if (images.length < 1 || images.length > 4 || images.some(value => { const u = new URL(value); return u.origin !== 'https://v3b.fal.media' || u.searchParams.get('identity') !== 'synthetic-read' || !uploads.get(u.pathname); }) || image.origin !== 'https://v3b.fal.media' ||
              image.searchParams.get('identity') !== 'synthetic-read' || !uploads.get(image.pathname))
              throw new Error('Expected one signed private uploaded scene.');
          }
          if (video) videoSubmits++;
          else imageSubmits++;
          const id = `synthetic-${video ? 'video' : 'image'}-${video ? videoSubmits : imageSubmits}`;
          requests.set(id, {
            video,
            ratio: String(body!.aspect_ratio),
            corrected: imageSubmits > 1,
            pendingStatuses: queueNext ? ['IN_QUEUE', 'IN_PROGRESS'] : [],
          });
          queueNext = false;
          if (loseSubmission) {
            loseSubmission = false;
            throw new Error('Synthetic lost acceptance response.');
          }
          return json({ request_id: id, status: 'IN_QUEUE' });
        }
        const match = /\/requests\/(synthetic-(?:video|image)-\d+)(\/status)?$/.exec(url.pathname);
        if (match) {
          const state = requests.get(match[1]!);
          if (!state) throw new Error('Unknown saved request.');
          if (retrievalFailure?.location === (match[2] ? 'status' : 'result')) {
            const failure = retrievalFailure;
            retrievalFailure = undefined;
            return new Response(new ReadableStream({
              pull(controller) {
                readErrorBodies++;
                controller.enqueue(new Uint8Array(2_250_000));
                controller.close();
              },
              cancel() {
                canceledErrorBodies++;
                if (rejectErrorCancellation) {
                  rejectErrorCancellation = false;
                  throw new Error('Synthetic response cancellation failure.');
                }
              },
            }, { highWaterMark: 0 }), {
              status: failure.status,
              headers: failure.bound === 'request'
                ? { 'x-fal-request-id': match[1]!, ...(failure.units === undefined ? {} : { 'x-fal-billable-units': failure.units }) }
                : failure.bound === 'type' ? { 'X-Fal-Error-Type': 'downstream_service_unavailable' } : {},
            });
          }
          if (match[2] && completedError) {
            const field = completedError;
            completedError = undefined;
            return json({ status: 'COMPLETED', [field]: 'downstream_service_unavailable' });
          }
          if (match[2]) return json({ status: state.pendingStatuses.shift() ?? 'COMPLETED' });
          const file = {
            url: `https://v3b.fal.media/files/b/synthetic/${match[1]}.${state.video ? 'mp4' : 'png'}`,
            content_type: null,
          };
          return json(state.video ? { video: file, seed: 1 } : { images: [file] });
        }
      }
      if (url.origin === 'https://rest.fal.ai' && url.pathname === '/storage/upload/initiate') {
        const lifecycle = JSON.parse(request.headers.get('X-Fal-Object-Lifecycle-Preference')!);
        if (request.headers.get('authorization') !== 'Key synthetic-fal-key' ||
          body!.file_name !== 'scene.png' || body!.content_type !== 'image/png' ||
          lifecycle.expiration_duration_seconds !== 3600 || lifecycle.initial_acl.default !== 'forbid')
          throw new Error('Expected a private expiring PNG upload.');
        const path = `/files/b/synthetic-upload/scene-${uploads.size + 1}.png`;
        uploads.set(path, null);
        const file = `https://v3b.fal.media${path}`;
        const upload = untrustedUpload ? `https://attacker.invalid${path}?signature=synthetic-write`
          : `${file}?signature=synthetic-write`;
        untrustedUpload = false;
        return json({ file_url: file, upload_url: upload });
      }
      if (url.origin === 'https://rest.fal.ai' && url.pathname === '/storage/auth/token') {
        if (body!.expiration_seconds !== 300)
          throw new Error('Expected short-lived private token.');
        const base = untrustedDownloadGrant
          ? 'https://v3b.fal.media.attacker.invalid'
          : 'https://v3b.fal.media';
        untrustedDownloadGrant = false;
        return json({
          token: 'synthetic-private-bearer',
          token_type: 'Bearer',
          base_url: base,
          created_at: new Date(now()).toISOString(),
          expires_at: new Date(now() + 300_000).toISOString(),
        });
      }
      if (url.origin === 'https://v3b.fal.media') {
        if (method === 'PUT') {
          if (request.headers.has('authorization') || request.headers.get('content-type') !== 'image/png' ||
            url.searchParams.get('signature') !== 'synthetic-write' || !uploads.has(url.pathname) || !binary)
            throw new Error('Unexpected upload credentials or destination.');
          uploads.set(url.pathname, binary);
          return new Response(null, { status: 200 });
        }
        if (method === 'POST' && url.pathname.endsWith('/sign')) {
          const path = url.pathname.slice(0, -5);
          if (request.headers.get('authorization') !== 'Bearer synthetic-private-bearer' ||
            body!.duration !== 3600 || JSON.stringify(body!.scope) !== '["read"]' || !uploads.get(path))
            throw new Error('Expected an uploaded scene and read-only one-hour signature.');
          const host = untrustedSignedUrl ? 'https://attacker.invalid' : url.origin;
          untrustedSignedUrl = false;
          return new Response(`${host}${path}?identity=synthetic-read`, { headers: { 'Content-Type': 'text/plain' } });
        }
        if (url.pathname.endsWith('.mp4')) {
          // Retention-only Seedance output is temporarily public at fal. The
          // service must download it directly without a probe or credentials.
          if (method !== 'GET' || request.headers.has('authorization') || request.headers.has('range') || request.redirect !== 'manual')
            throw new Error('Expected a direct bounded video download without credentials or redirects.');
          const requestId = url.pathname.split('/').at(-1)!.replace(/\.mp4$/, '');
          const state = requests.get(requestId);
          if (!state?.video) throw new Error('Unknown completed video output.');
          const movie = state.ratio === '9:16' ? options.verticalVideo ?? options.video : options.video;
          return new Response(movie, { headers: { 'Content-Type': 'video/mp4' } });
        }
        if (method === 'GET' && url.searchParams.get('identity') === 'synthetic-read') {
          const bytes = uploads.get(url.pathname);
          if (!bytes || request.headers.has('authorization') || request.headers.has('range') || request.redirect !== 'manual')
            throw new Error('Expected an unauthenticated signed reference download.');
          if (corruptSignedRead) {
            corruptSignedRead = false;
            return new Response('not the uploaded image');
          }
          return new Response(bytes, { headers: { 'content-type': 'image/png' } });
        }
        if (!request.headers.has('authorization')) {
          if (request.headers.get('range') !== 'bytes=0-0')
            throw new Error('Expected an unauthenticated range probe.');
          // Deliberately larger than the JSON body limit; this is a normal 403 body,
          // not an image or token response, and must not be buffered or rejected.
          return new Response('Forbidden '.repeat(32_000), { status: 403 });
        }
        if (request.headers.get('authorization') !== 'Bearer synthetic-private-bearer')
          throw new Error('Wrong CDN credential.');
        if (failDownload) {
          failDownload = false;
          return new Response('Temporary unavailable', { status: 503 });
        }
        return new Response(
          url.pathname.includes('image-2') ? corrected : initial,
          { headers: { 'Content-Type': 'application/octet-stream' } },
        );
      }
      throw new Error(
        `Unexpected synthetic outbound endpoint: ${method} ${url.origin}${url.pathname}`,
      );
    },
  };
}
