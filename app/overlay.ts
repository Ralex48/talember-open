import { bounded, ProviderError } from './security';
import { mp4 } from './media';
import { MAX_VIDEO, type Job, type ServiceEnv } from './types';

export const overlayCopy = {
  en: 'Your exact greeting will be added automatically during the final three seconds. Keep lettering out of the video script.',
  ru: 'Ваше пожелание будет добавлено без изменений в последние три секунды. Не включайте надписи в сценарий видео.',
  es: 'Añadiremos tu mensaje exacto durante los últimos tres segundos. No incluyas rótulos en el guion del vídeo.',
  he: 'הברכה תתווסף בדיוק כפי שנכתבה בשלוש השניות האחרונות. אין לכלול כיתוב בתסריט הסרטון.',
};
export const effectCopy = {
  en: ['Greeting effect', 'None', 'Hearts', 'Fireworks', 'Hearts and fireworks'],
  ru: ['Эффект пожелания', 'Без эффекта', 'Сердечки', 'Фейерверк', 'Сердечки и фейерверк'],
  es: ['Efecto del mensaje', 'Ninguno', 'Corazones', 'Fuegos artificiales', 'Corazones y fuegos artificiales'],
  he: ['אפקט לברכה', 'ללא', 'לבבות', 'זיקוקים', 'לבבות וזיקוקים'],
};
export const colorCopy = {
  en: ['Text colour', 'White', 'Gold', 'Pink', 'Multicolour'],
  ru: ['Цвет текста', 'Белый', 'Золотой', 'Розовый', 'Разноцветный'],
  es: ['Color del texto', 'Blanco', 'Dorado', 'Rosa', 'Multicolor'],
  he: ['צבע הטקסט', 'לבן', 'זהב', 'ורוד', 'רב־צבעוני'],
};

export function overlayEnabled(env: ServiceEnv): boolean {
  return env.TALEMBER_OVERLAY_ENABLED === 'true' && !!env.TALEMBER_RENDERER;
}

// A private service binding; the renderer accepts media bytes, never source URLs.
// Retry this deterministic stage using the saved video, never repurchase Seedance.
export async function renderGreeting(env: ServiceEnv, job: Job): Promise<Uint8Array> {
  if (!env.TALEMBER_RENDERER || !job.raw_video_key || !job.paid_at || !job.capture_id ||
    !job.video_script_approved_at || job.video_script_approved_revision !== job.video_script_revision)
    throw new ProviderError('retry');
  const source = await env.TALEMBER_PRIVATE_MEDIA.get(job.raw_video_key);
  if (!source) throw new ProviderError('retry');
  const bytes = await bounded(source.body, MAX_VIDEO);
  mp4(bytes, job.video_ratio);
  if (!job.closing_wish) return bytes;
  const metadata = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({
    text: job.closing_wish ?? '', locale: job.locale, effect: job.greeting_effect ?? 'none', color: job.greeting_color ?? 'white', font: job.greeting_font ?? 'classic', layout: {x:job.overlay_x,y:job.overlay_y,scale:job.overlay_scale,elements:JSON.parse(job.overlay_elements_json??'[]')},
  }))));
  const response = await env.TALEMBER_RENDERER.fetch('https://renderer/render', {
    method: 'POST', headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(bytes.length), 'X-Greeting': metadata },
    body: bytes, signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok || response.headers.get('content-type') !== 'video/mp4') throw new ProviderError('retry');
  const result = await bounded(response.body, MAX_VIDEO);
  mp4(result, job.video_ratio);
  return result;
}
