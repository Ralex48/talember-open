import { MAX_IMAGE, MAX_VIDEO, type Job, type Photo, type ServiceEnv, type VideoRatio } from './types';
import { bounded, hash, identifier, ProviderError, record, remote, remoteJson } from './security';
import { png, mp4 } from './media';
import { savedImageSelection } from './director';
import { selectedSource } from './script';
import { falJson } from './funding';
import { preserveFailure, preserveResponse } from './diagnostics';
import { referenceKeys } from './references';
import { CLOTHING_PROMPT, IMAGE_PROMPTS } from './image-prompts';

const CARTOON_STYLE = 'Warm hand-drawn 2D cartoon, clean contour lines, soft flat shading and muted natural colors. Preserve this photo’s exact people, recognizable faces, hair, age, proportions, poses, relative positions, background, framing and orientation. Preserve clothing except for this narrow clothing adjustment: replace underwear or brief-like bottoms with opaque, slightly longer summer shorts or swim shorts. Keep the original colors, pattern, waistband, material appearance and overall shape; extend the legs and loosen the fit only as much as needed for ordinary shorts coverage. Preserve ordinary swimwear and other clothing; do not redesign outfits or add a shirt solely because an adult is shirtless. This clothing adjustment takes priority over other outfit-preservation instructions. Do not add people from other photos, change the composition or invent objects. No text.';

async function simplePhotoBody(env: ServiceEnv, job: Job, index: number): Promise<string> {
  const photos = JSON.parse(job.photos_json!) as Photo[];
  const photo = photos[index - 1];
  if (!photo) throw new ProviderError('invalid');
  const source = await env.TALEMBER_PRIVATE_MEDIA.get(photo.key);
  if (!source) throw new ProviderError('invalid');
  const bytes = await bounded(source.body, 5 * 1024 * 1024);
  if (await hash(bytes) !== photo.sha256) throw new ProviderError('invalid');
  const images = [dataUri(bytes, photo.type)];
  return JSON.stringify({
    prompt: `${IMAGE_PROMPTS[job.style === 'realistic' ? 'realistic' : 'cartoon']}\n\n${CLOTHING_PROMPT}`,
    image_urls: images,
    num_images: 1, aspect_ratio: 'auto', resolution: '1K', output_format: 'png', limit_generations: true, enable_web_search: false, sync_mode: false,
  });
}

export async function characterBody(env: ServiceEnv, job: Job, index: number): Promise<string> {
  if (index < 2 || index > 4) throw new ProviderError('invalid');
  return simplePhotoBody(env, job, index);
}

const QUEUE = 'https://queue.fal.run/fal-ai/nano-banana-pro';
export class UnchargedFailure extends ProviderError {
  constructor(public readonly requestId: string) { super('invalid'); }
}
const VIDEO_QUEUE = 'https://queue.fal.run/bytedance/seedance-2.0';
export const LIFECYCLE = JSON.stringify({
  expiration_duration_seconds: 3600,
  initial_acl: { default: 'forbid', rules: [] },
});
// Seedance rejects the private output ACL. Retain its temporary output for one
// hour; validated video bytes are stored in private R2 before customer delivery.
const VIDEO_LIFECYCLE = JSON.stringify({ expiration_duration_seconds: 3600 });
function key(env: ServiceEnv): Record<string, string> {
  return { Authorization: `Key ${env.FAL_API_KEY}` };
}
function dataUri(bytes: Uint8Array, type: string): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192)
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return `data:${type};base64,${btoa(chunks.join(''))}`;
}
export async function submissionBody(
  env: ServiceEnv,
  job: Job,
  correction: boolean,
): Promise<string> {
  if (!correction) return simplePhotoBody(env, job, 1);
  const photos = JSON.parse(job.photos_json!) as Photo[];
  const selection = savedImageSelection(
    JSON.parse(correction ? job.correction_direction_json! : job.direction_json!),
    photos.length,
    correction,
  );
  const imageUrls: string[] = [];
  if (correction) {
    const original = await env.TALEMBER_PRIVATE_MEDIA.get(job.original_key!);
    if (!original) throw new ProviderError('invalid');
    imageUrls.push(dataUri(await bounded(original.body, MAX_IMAGE), 'image/png'));
  } else {
    for (const photo of photos) {
      const object = await env.TALEMBER_PRIVATE_MEDIA.get(photo.key);
      if (!object) throw new ProviderError('invalid');
      const bytes = await bounded(object.body, 5 * 1024 * 1024);
      if ((await hash(bytes)) !== photo.sha256) throw new ProviderError('invalid');
      imageUrls.push(dataUri(bytes, photo.type));
    }
  }
  const prompt = JSON.stringify({
    task: correction
      ? 'Apply only the exact requested correction to the original image.'
      : job.style === 'realistic'
        ? 'Create one photorealistic image from the supplied photo references.'
        : job.style === 'storybook'
          ? 'Create one gentle painted storybook illustration with subtle paper texture from the supplied photo references. Preserve the photographed subjects, room, poses and outfits.'
          : 'Create one cartoon image from the supplied photo references.',
    style: job.style ?? 'cartoon',
    ...(correction ? { visual_style: CARTOON_STYLE } : {
      clothing: 'Only where bottoms look like underwear, slightly lengthen them into shorts, keeping their color and design. Leave other clothing unchanged.',
    }),
    selection,
    characters: correction ? { instruction: 'Only the people and animals actually visible in this single photograph.' } : { cast: job.cast, count: job.participants },
    scene: {
      reference: correction ? 'scene' : 'photo1',
      environment: 'The exact environment visible in this reference image.',
      framing: 'Preserve this reference image’s framing, aspect ratio and orientation. Keep all subjects visible.',
    },
    correction: correction ? job.correction : null,
    grounding: {
      instruction:
        'Compose only these mapped characters and this exact environment; add no person, relationship, setting, object, event, sentiment, or fact.',
      references: correction ? ['scene'] : photos.map((_, i) => `photo${i + 1}`),
    },
    locale: job.locale,
  });
  return JSON.stringify({
    prompt,
    image_urls: imageUrls,
    num_images: 1,
    aspect_ratio: 'auto',
    resolution: '1K',
    output_format: 'png',
    limit_generations: true,
    enable_web_search: false,
    sync_mode: false,
  });
}
export async function videoBody(env: ServiceEnv, job: Job): Promise<string> {
  const chosen = selectedSource(job);
  if (!chosen || chosen !== job.video_script_source_key || !job.video_script_approved_at ||
    job.video_script_approved_revision !== job.video_script_revision || !job.video_script)
    throw new ProviderError('invalid');
  if (job.references_json !== job.script_references_json) throw new ProviderError('invalid');
  const images: string[] = [];
  for (const key of referenceKeys(job)) {
    const object = await env.TALEMBER_PRIVATE_MEDIA.get(key);
    if (!object) throw new ProviderError('invalid');
    const bytes = await bounded(object.body, MAX_IMAGE);
    png(bytes);
    images.push(await uploadVideoReference(env, bytes));
  }
  return JSON.stringify({
    prompt: job.video_script,
    image_urls: images,
    end_user_id: job.id,
    duration: '15',
    resolution: '720p',
    aspect_ratio: job.video_ratio,
    generate_audio: true,
    bitrate_mode: 'standard',
  });
}
export async function submit(env: ServiceEnv, body: string, video = false): Promise<string> {
  const response = await falJson(
    await remote(video ? `${VIDEO_QUEUE}/reference-to-video` : `${QUEUE}/edit`, {
      method: 'POST',
      body,
      headers: {
        ...key(env),
        'Content-Type': 'application/json',
        'X-Fal-Store-IO': '0',
        'X-Fal-Request-Timeout': '600',
        'x-app-fal-disable-fallback': 'true',
        'X-Fal-Object-Lifecycle-Preference': video ? VIDEO_LIFECYCLE : LIFECYCLE,
      },
    }), true,
  );
  return identifier(response.request_id);
}
function cdnFileUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new ProviderError('invalid');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError('invalid');
  }
  if (
    url.origin !== 'https://v3b.fal.media' ||
    !/^\/files\/b\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ProviderError('private');
  return url.href;
}
async function verifyPrivate(url: string): Promise<void> {
  const probe = await remote(url, { headers: { Range: 'bytes=0-0' } });
  const denied = probe.status === 401 || probe.status === 403;
  // Only the access decision matters. An arbitrary provider error body is never
  // interpreted as an image, buffered or subjected to the image-size restriction.
  await probe.body?.cancel();
  if (!denied) throw new ProviderError('private');
}
async function cdnToken(env: ServiceEnv): Promise<string> {
  const issuedAt = Date.now();
  const auth = await falJson(
    await remote('https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3', {
      method: 'POST',
      headers: { ...key(env), 'Content-Type': 'application/json' },
      body: JSON.stringify({ expiration_seconds: 300 }),
    }),
  );
  const expires = typeof auth.expires_at === 'string' ? Date.parse(auth.expires_at) : NaN;
  if (
    typeof auth.token !== 'string' ||
    !/^\S{1,8192}$/.test(auth.token) ||
    typeof auth.token_type !== 'string' ||
    auth.token_type.toLowerCase() !== 'bearer' ||
    ![
      'https://v3.fal.media',
      'https://v3.fal.media/',
      'https://v3b.fal.media',
      'https://v3b.fal.media/',
    ].some((base) => auth.base_url === base) ||
    !Number.isFinite(expires) ||
    expires <= Date.now() + 15_000 ||
    expires > issuedAt + 330_000
  )
    throw new ProviderError('invalid');
  return auth.token;
}
async function download(env: ServiceEnv, url: string, video: boolean, ratio: VideoRatio = '9:16'): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (!video) {
    await verifyPrivate(url);
    headers.Authorization = `Bearer ${await cdnToken(env)}`;
  }
  const response = await remote(url, { headers }, 60_000);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (
    response.status !== 200 ||
    (mime && ![video ? 'video/mp4' : 'image/png', 'application/octet-stream'].includes(mime))
  ) {
    await response.body?.cancel();
    throw new ProviderError('retry');
  }
  const bytes = await bounded(response.body, video ? MAX_VIDEO : MAX_IMAGE);
  if (video) {
    mp4(bytes, ratio);
    return bytes;
  }
  const size = png(bytes);
  if (Math.min(size.width, size.height) < 360 || Math.max(size.width, size.height) < 640)
    throw new ProviderError('invalid');
  return bytes;
}
function signedFileUrl(value: unknown, file: string, credential: 'signature' | 'identity'): string {
  if (typeof value !== 'string' || value.length > 16_384) throw new ProviderError('private');
  let url: URL;
  try { url = new URL(value); } catch { throw new ProviderError('private'); }
  const expected = new URL(file);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname ||
    url.username || url.password || url.hash ||
    [...url.searchParams.keys()].length !== 1 || !url.searchParams.get(credential))
    throw new ProviderError('private');
  return url.href;
}
async function uploadVideoReference(env: ServiceEnv, bytes: Uint8Array): Promise<string> {
  const upload = await falJson(await remote(
    'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', {
      method: 'POST',
      headers: { ...key(env), 'Content-Type': 'application/json',
        'X-Fal-Object-Lifecycle-Preference': LIFECYCLE },
      body: JSON.stringify({ file_name: 'scene.png', content_type: 'image/png' }),
    },
  ));
  const file = cdnFileUrl(upload.file_url);
  const destination = signedFileUrl(upload.upload_url, file, 'signature');
  const uploaded = await remote(destination, {
    method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: bytes,
  }, 60_000);
  await uploaded.body?.cancel();
  if (!uploaded.ok) throw new ProviderError('retry');
  await verifyPrivate(file);
  const token = await cdnToken(env);
  const signed = await remote(`${file}/sign`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ duration: 3600, scope: ['read'] }),
  });
  if (!signed.ok) {
    await signed.body?.cancel();
    throw new ProviderError('retry');
  }
  const reference = signedFileUrl(new TextDecoder().decode(await bounded(signed.body, 16_384)).trim(), file, 'identity');
  // Verify the exact unauthenticated URL supplied to the video model. Do not
  // send our API key, follow redirects or trust a successful upload alone.
  const probe = await remote(reference);
  if (!probe.ok) { await probe.body?.cancel(); throw new ProviderError('retry'); }
  const downloaded = await bounded(probe.body, MAX_IMAGE);
  png(downloaded);
  if (await hash(downloaded) !== await hash(bytes)) throw new ProviderError('private');
  return reference;
}
export async function result(
  env: ServiceEnv,
  requestId: string,
  video = false,
  ratio: VideoRatio = '9:16',
  jobId?: string,
): Promise<Uint8Array | null> {
  const path = `${video ? VIDEO_QUEUE : QUEUE}/requests/${identifier(requestId)}`;
  const status = await falJson(await remote(`${path}/status?logs=0`, { headers: key(env) }));
  if (status.status === 'IN_QUEUE' || status.status === 'IN_PROGRESS') return null;
  if (status.status !== 'COMPLETED') throw new ProviderError('invalid');
  if (status.error || status.error_type) {
    if (jobId) await preserveFailure(env, jobId, requestId, 200, status);
    throw new ProviderError('invalid');
  }
  const response = await remote(path, { headers: key(env) });
  const uncharged = response.headers.get('x-fal-request-id') === requestId &&
    /^0(?:\.0+)?$/.test(response.headers.get('x-fal-billable-units') ?? '');
  if (!response.ok && (response.status === 404 || response.status === 422 ||
    response.headers.get('x-fal-request-id') === requestId ||
    response.headers.get('X-Fal-Error-Type') ||
    response.headers.get('X-Fal-Request-Timeout-Type') === 'user')) {
    // Private bounded diagnostics survive failed attempts. No response payload
    // enters logs or customer pages, and failure never buys a replacement.
    if (jobId) await preserveResponse(env, jobId, requestId, response);
    else await response.body?.cancel().catch(() => undefined);
    if (uncharged && (response.status === 422 || response.status >= 500))
      throw new UnchargedFailure(requestId);
    throw new ProviderError('invalid');
  }
  const output = await remoteJson(response);
  if (video) {
    const movie = record(output.video);
    if (movie.content_type != null && movie.content_type !== 'video/mp4')
      throw new ProviderError('invalid');
    return download(env, cdnFileUrl(movie.url), true, ratio);
  }
  if (!Array.isArray(output.images) || output.images.length !== 1)
    throw new ProviderError('invalid');
  const image = record(output.images[0]);
  if (image.content_type != null && image.content_type !== 'image/png')
    throw new ProviderError('invalid');
  return download(env, cdnFileUrl(image.url), false);
}
