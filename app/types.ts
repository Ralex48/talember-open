export type ServiceEnv = Env & {
  TALEMBER_OVERLAY_ENABLED?: string;
  TALEMBER_RENDERER?: Fetcher;
  TALEMBER_CREATION_ENABLED?: string;
  TALEMBER_CREATION_TEST_JOB?: string;
  TALEMBER_PUBLIC_ORIGIN?: string;
  FAL_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  TALEMBER_IMAGE_PROVIDER?: 'fal' | 'openrouter';
  OPENROUTER_DIRECTOR_MODEL?: string;
  PAYPAL_SANDBOX_CLIENT_ID?: string;
  PAYPAL_SANDBOX_CLIENT_SECRET?: string;
  PAYPAL_SANDBOX_ENVIRONMENT?: string;
  TALEMBER_PAYMENT_ENVIRONMENT?: string;
  PAYPAL_LIVE_CLIENT_ID?: string;
  PAYPAL_LIVE_CLIENT_SECRET?: string;
  PAYPAL_LIVE_MERCHANT_ID?: string;
  TALEMBER_SUPPORT_URL?: string;
  TALEMBER_BUSINESS_NAME?: string;
  TALEMBER_ALERT_EMAIL?: SendEmail;
  TALEMBER_ALERT_FROM?: string;
  TALEMBER_ALERT_TO?: string;
};

export type Phase =
  | 'draft'
  | 'uploading'
  | 'ordering'
  | 'awaiting_paypal'
  | 'capturing'
  | 'paid'
  | 'directing'
  | 'directed'
  | 'submitting'
  | 'generating'
  | 'ready'
  | 'correcting'
  | 'correction_submitting'
  | 'correction_generating'
  | 'choice'
  | 'selected'
  | 'correction_directing'
  | 'correction_directed'
  | 'video_directing'
  | 'video_directed'
  | 'video_submitting'
  | 'video_generating'
  | 'complete'
  | 'attention'
  | 'deleting';

export interface Photo {
  key: string;
  type: 'image/jpeg' | 'image/png';
  sha256: string;
  width?: number;
  height?: number;
}
export type Style = 'cartoon' | 'storybook' | 'realistic';
export type Price = '9.99' | '14.99' | '19.99';
export type PaymentEnvironment = 'sandbox' | 'live';
export type VideoFormat = 'match' | 'vertical' | 'horizontal';
export type VideoRatio = '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16';
export interface Job {
  overlay_elements_json: string | null;
  overlay_review: number;
  overlay_x: number;
  overlay_y: number;
  overlay_scale: number;
  overlay_revision: number;
  overlay_version: number;
  raw_video_key: string | null;
  references_json: string | null;
  script_references_json: string | null;
  id: string;
  session_hash: string;
  csrf: string;
  origin: string;
  phase: Phase;
  amount: Price;
  payment_environment: PaymentEnvironment;
  story: string | null;
  closing_wish: string | null;
  greeting_effect: 'none' | 'hearts' | 'fireworks' | 'celebration';
  greeting_color: 'white' | 'gold' | 'pink' | 'multicolor';
  greeting_font: 'classic' | 'fredoka' | 'pacifico' | 'lobster' | 'caveat';
  style: Style;
  video_format: VideoFormat;
  video_ratio: VideoRatio;
  photos_json: string | null;
  snapshot_at: number | null;
  cast: string | null;
  participants: number | null;
  consent_at: number | null;
  locale: 'en' | 'ru' | 'es' | 'he';
  order_id: string | null;
  approval_url: string | null;
  payee_id: string | null;
  order_started_at: number | null;
  capture_started_at: number | null;
  capture_id: string | null;
  paid_at: number | null;
  direction_json: string | null;
  direction_request_id: string | null;
  request_id: string | null;
  submitted_at: number | null;
  original_key: string | null;
  correction: string | null;
  correction_request_id: string | null;
  correction_direction_json: string | null;
  correction_direction_request_id: string | null;
  correction_submitted_at: number | null;
  corrected_key: string | null;
  selected: 'original' | 'corrected' | null;
  issue: string | null;
  video_direction_json: string | null;
  video_direction_request_id: string | null;
  video_script: string | null;
  video_script_revision: number;
  video_script_source_key: string | null;
  video_script_approved_at: number | null;
  video_script_approved_revision: number | null;
  video_request_id: string | null;
  video_submitted_at: number | null;
  video_key: string | null;
  content_expires_at: number | null;
  content_deleted_at: number | null;
  lease_token: string | null;
  lease_until: number;
  next_at: number;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

export const PRICE: Price = '19.99';
export const DAY = 86_400_000;
export const MAX_PHOTO = 5 * 1024 * 1024;
export const MAX_IMAGE = 16 * 1024 * 1024;
export const MAX_VIDEO = 64 * 1024 * 1024;
export const MAX_SCRIPT = 12000;
export const MAX_CLOSING_WISH = 80;
export const LEASE = 180_000;
export const BUSY: readonly Phase[] = [
  'uploading',
  'ordering',
  'capturing',
  'paid',
  'directing',
  'directed',
  'submitting',
  'generating',
  'ready',
  'choice',
  'correcting',
  'correction_directing',
  'correction_directed',
  'correction_submitting',
  'correction_generating',
  'selected',
  'video_directing',
  'video_directed',
  'video_submitting',
  'video_generating',
];
export function reviewing(job: Job): boolean {
  return job.phase === 'video_directed' && job.video_script !== null &&
    job.video_script_approved_at === null && !job.video_request_id;
}
export function displayPhase(job: Job): string {
  if (job.overlay_review) return 'overlay_review';
  if (job.issue === 'provider_balance') return 'provider_wait';
  return reviewing(job) ? 'script_review' : job.phase;
}
export function busy(job: Job): boolean {
  return BUSY.includes(job.phase) && !reviewing(job) && !job.overlay_review;
}
export function enabled(env: ServiceEnv, jobId: string, mode = paymentEnvironment(env)): boolean {
  return (
    env.TALEMBER_CREATION_ENABLED === 'true' &&
    (!env.TALEMBER_CREATION_TEST_JOB || env.TALEMBER_CREATION_TEST_JOB === jobId) &&
    mode === paymentEnvironment(env) &&
    (mode !== 'live' || Boolean(supportUrl(env) && env.TALEMBER_BUSINESS_NAME)) &&
    paymentReady(env, paymentEnvironment(env)) &&
    Boolean(
      env.FAL_API_KEY &&
      env.OPENROUTER_API_KEY &&
      env.OPENROUTER_DIRECTOR_MODEL &&
      env.TALEMBER_PUBLIC_ORIGIN,
    )
  );
}
export function supportUrl(env: ServiceEnv): string | null {
  try {
    const url = new URL(env.TALEMBER_SUPPORT_URL ?? '');
    return ['https:', 'mailto:'].includes(url.protocol) && !url.username && !url.password &&
      (url.protocol !== 'mailto:' || /^[^\s?@]+@[^\s?@]+\.[^\s?@]+$/.test(url.pathname)) ? url.href : null;
  } catch { return null; }
}
export function paymentEnvironment(env: ServiceEnv): PaymentEnvironment {
  return env.TALEMBER_PAYMENT_ENVIRONMENT === 'live' ? 'live' : 'sandbox';
}
export function paymentReady(env: ServiceEnv, mode: PaymentEnvironment): boolean {
  if (env.TALEMBER_PAYMENT_ENVIRONMENT && !['sandbox', 'live'].includes(env.TALEMBER_PAYMENT_ENVIRONMENT)) return false;
  return mode === 'live'
    ? Boolean(env.PAYPAL_LIVE_CLIENT_ID && env.PAYPAL_LIVE_CLIENT_SECRET && env.PAYPAL_LIVE_MERCHANT_ID)
    : env.PAYPAL_SANDBOX_ENVIRONMENT === 'sandbox' && Boolean(env.PAYPAL_SANDBOX_CLIENT_ID && env.PAYPAL_SANDBOX_CLIENT_SECRET);
}
