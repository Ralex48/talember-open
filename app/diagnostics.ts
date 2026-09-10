import { identifier } from './security';
import type { ServiceEnv } from './types';

export function diagnosticKey(jobId: string, requestId: string): string {
  return `diagnostics/${identifier(jobId)}/${identifier(requestId)}.json`;
}
// Keep useful provider errors privately, without credentials, signed URLs or
// echoed input fields. Never return this material in customer HTML or logs.
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth limit]';
  if (typeof value === 'string') return value
    .replace(/data:[^\s"<>]+/gi, '[media removed]')
    .replace(/https?:\/\/[^\s"<>]+/g, '[URL removed]')
    .replace(/\b(?:Bearer|Key)\s+[^\s"<>]+/gi, '[credential removed]')
    .replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, '[email removed]')
    .slice(0, 4000);
  if (Array.isArray(value)) return value.slice(0, 30).map(item => scrub(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => ['detail', 'error', 'error_type', 'message', 'msg', 'type', 'loc', 'code', 'billable_units'].includes(key))
    .map(([key, item]) => [key, scrub(item, depth + 1)]));
  return value;
}
export async function preserveFailure(env: ServiceEnv, jobId: string, requestId: string, status: number, body: unknown): Promise<void> {
  await env.TALEMBER_PRIVATE_MEDIA.put(diagnosticKey(jobId, requestId), JSON.stringify({
    requestId, status, recordedAt: Date.now(), details: scrub(body),
  }), { httpMetadata: { contentType: 'application/json' } });
}
export async function preserveResponse(env: ServiceEnv, jobId: string, requestId: string, response: Response): Promise<void> {
  // Keep the bounded prefix even if the stream fails or exceeds the limit.
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0, state = 'complete';
  try {
    while (reader) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = 64 * 1024 - size;
      text += decoder.decode(value.subarray(0, remaining), { stream: true });
      size += Math.min(value.length, remaining);
      if (value.length > remaining) { state = 'truncated'; break; }
    }
  } catch { state = 'read_failed'; }
  finally {
    text += decoder.decode();
    if (reader) {
      if (state !== 'complete') await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  let body: unknown;
  try { body = JSON.parse(text); }
  catch { body = { message: text.slice(0, 4000), type: text ? 'non_json' : 'empty_body' }; }
  // Preserve headers and capture outcome independently of body parsing.
  body = { detail: body, code: response.headers.get('x-fal-error-type'),
    type: state, message: response.headers.get('content-type'),
    billable_units: response.headers.get('x-fal-billable-units') };
  // An empty/unreadable later fetch must not overwrite earlier useful evidence.
  if (!text && await env.TALEMBER_PRIVATE_MEDIA.head(diagnosticKey(jobId, requestId))) return;
  await preserveFailure(env, jobId, requestId, response.status, body);
}
export async function clearDiagnostics(env: ServiceEnv, jobId: string): Promise<boolean> {
  const objects = await env.TALEMBER_PRIVATE_MEDIA.list({ prefix: `diagnostics/${identifier(jobId)}/`, limit: 100 });
  if (objects.objects.length) await env.TALEMBER_PRIVATE_MEDIA.delete(objects.objects.map(object => object.key));
  return !objects.truncated;
}
