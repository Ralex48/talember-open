import type { Job, ServiceEnv } from './types';
import { characterBody, submissionBody } from './fal';
import { bounded, ProviderError } from './security';
import { png } from './media';

export const IMAGE_MODEL = 'openai/gpt-image-2.5-sunburst';
export async function referenceImage(env: ServiceEnv, job: Job, photo: number, model: string): Promise<Uint8Array> {
  if (!job.paid_at || !job.capture_id || !env.OPENROUTER_API_KEY ||
    !['openai/gpt-image-2.5-sunburst', 'openai/gpt-image-2.5-flare'].includes(model)) throw new ProviderError('invalid');
  const source = JSON.parse(await (photo === 1 ? submissionBody(env, job, false) : characterBody(env, job, photo)));
  const signal = AbortSignal.timeout(150_000);
  const response = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST', redirect: 'manual', signal,
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: source.prompt, n: 1, quality: 'high', aspect_ratio: 'auto',
      input_references: [{ type: 'image_url', image_url: { url: source.image_urls[0] } }],
      provider: { only: ['openai'], allow_fallbacks: false }, }),
  });
  const raw = await bounded(response.body, 32 * 1024 * 1024);
  if (!response.ok) throw new ProviderError('invalid');
  const result = JSON.parse(new TextDecoder().decode(raw));
  if (result.data?.length !== 1 || typeof result.data[0].b64_json !== 'string') throw new ProviderError('invalid');
  const bytes = Uint8Array.from(atob(result.data[0].b64_json), c => c.charCodeAt(0));
  png(bytes);
  return bytes;
}
