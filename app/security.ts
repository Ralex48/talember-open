import type { Job, ServiceEnv } from './types';

export class PublicError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export class ProviderError extends Error {
  constructor(public readonly kind: 'retry' | 'invalid' | 'private' = 'retry') {
    super(kind);
  }
}
export function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
export async function hash(value: string | Uint8Array): Promise<string> {
  const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (n) =>
    n.toString(16).padStart(2, '0'),
  ).join('');
}
export function cookieName(request: Request): string {
  return new URL(request.url).protocol === 'https:'
    ? '__Host-talember-creation'
    : 'talember-creation-local';
}
export function sessionCookie(request: Request, token: string): string {
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2678400${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export function renewCookie(request: Request): string | null {
  const token = sessionToken(request);
  return token ? sessionCookie(request, token) : null;
}
function sessionToken(request: Request): string | null {
  const cookies = (request.headers.get('cookie') ?? '').split(';').map((x) => x.trim());
  const tokens = cookies.filter((x) => x.startsWith(`${cookieName(request)}=`));
  if (tokens.length !== 1) return null;
  const token = tokens[0]!.slice(cookieName(request).length + 1);
  return /^[a-f0-9]{64}$/.test(token) ? token : null;
}
export async function nextSessionToken(request: Request, job: Job): Promise<string> {
  const token = sessionToken(request);
  if (!token) throw new PublicError(401, 'Please return to your Talember page.');
  // Never derive a capability from the public job ID or visible CSRF alone.
  // Repeated confirmations with the same old HttpOnly token identify one draft.
  return hash(`talember-next-session:v1:${token}:${job.id}`);
}
export async function ownedJob(request: Request, env: ServiceEnv): Promise<Job | null> {
  const token = sessionToken(request);
  if (!token) return null;
  return env.TALEMBER_DB.prepare(
    'SELECT * FROM creation_jobs WHERE session_hash = ? AND expires_at > ? AND phase != ?',
  )
    .bind(await hash(token), Date.now(), 'deleting')
    .first<Job>();
}
export function sameOrigin(request: Request): void {
  const origin = new URL(request.url).origin;
  if (
    request.headers.get('origin') !== origin ||
    request.headers.get('sec-fetch-site') === 'cross-site'
  ) {
    throw new PublicError(403, 'Please return to your Talember page and try again.');
  }
}
export function csrf(job: Job, value: string | File | null): void {
  if (
    typeof value !== 'string' ||
    value.length !== job.csrf.length ||
    !crypto.subtle.timingSafeEqual(
      new TextEncoder().encode(value),
      new TextEncoder().encode(job.csrf),
    )
  ) {
    throw new PublicError(403, 'Please return to your Talember page and try again.');
  }
}
export async function bounded(
  body: ReadableStream<Uint8Array> | null,
  maximum: number,
): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum)
        throw new PublicError(413, 'That file is too large. Please choose a smaller image.');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
export async function form(request: Request, maximum = 16 * 1024 * 1024): Promise<FormData> {
  const type = request.headers.get('content-type') ?? '';
  if (
    !type.startsWith('multipart/form-data;') &&
    !type.startsWith('application/x-www-form-urlencoded')
  ) {
    throw new PublicError(415, 'Please submit the form on this page.');
  }
  const bytes = await bounded(request.body, maximum);
  try {
    return await new Response(bytes, { headers: { 'content-type': type } }).formData();
  } catch {
    throw new PublicError(400, 'We could not read that form. Please try again.');
  }
}
export function textField(data: FormData, name: string, min: number, max: number): string {
  const entries = data.getAll(name);
  const value = entries[0];
  if (
    entries.length !== 1 ||
    typeof value !== 'string' ||
    value.trim().length < min ||
    value.length > max
  ) {
    const label =
      name === 'story'
        ? 'your story'
        : name === 'cast'
          ? 'who is in each photo'
          : name === 'correction'
            ? 'your improvement'
            : 'your choice';
    throw new PublicError(400, `Describe ${label} in ${min}–${max} characters.`);
  }
  return value.trim();
}
export function safe(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set(
    'Content-Security-Policy',
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; form-action 'self' https://www.sandbox.paypal.com https://www.paypal.com; frame-ancestors 'none'; base-uri 'none'",
  );
  // Native same-origin form POSTs need their origin. Do not disclose a referrer
  // to PayPal or any other origin, and keep strict Origin + CSRF validation.
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  return new Response(response.body, { status: response.status, headers });
}
export async function remote(
  url: string,
  init: RequestInit = {},
  timeout = 20_000,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  } catch {
    throw new ProviderError('retry');
  }
}
export async function remoteJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new ProviderError('retry');
  }
  try {
    const value: unknown = JSON.parse(
      new TextDecoder().decode(await bounded(response.body, 128 * 1024)),
    );
    return record(value);
  } catch {
    throw new ProviderError('invalid');
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ProviderError('invalid');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(value))
    throw new ProviderError('invalid');
  return value;
}
