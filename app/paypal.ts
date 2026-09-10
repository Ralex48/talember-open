import { paymentReady, type Job, type ServiceEnv, type PaymentEnvironment } from './types';
import { identifier, ProviderError, record, remote, remoteJson } from './security';

export type PaymentOrder = Pick<Job, 'id' | 'amount' | 'payment_environment' | 'order_id' | 'payee_id'>;
function api(mode: PaymentEnvironment): string {
  return mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
}
export function approvalOrigin(mode: PaymentEnvironment): string {
  return mode === 'live' ? 'https://www.paypal.com' : 'https://www.sandbox.paypal.com';
}
async function access(env: ServiceEnv, mode: PaymentEnvironment): Promise<string> {
  if (!paymentReady(env, mode)) throw new ProviderError('invalid');
  const client = mode === 'live' ? env.PAYPAL_LIVE_CLIENT_ID : env.PAYPAL_SANDBOX_CLIENT_ID;
  const secret = mode === 'live' ? env.PAYPAL_LIVE_CLIENT_SECRET : env.PAYPAL_SANDBOX_CLIENT_SECRET;
  const result = await remoteJson(
    await remote(`${api(mode)}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${client}:${secret}`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    }),
  );
  if (
    typeof result.access_token !== 'string' ||
    result.access_token.length > 8000 ||
    result.token_type !== 'Bearer'
  )
    throw new ProviderError('invalid');
  return result.access_token;
}
function headers(token: string, requestId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    Prefer: 'return=representation',
    ...(requestId ? { 'PayPal-Request-Id': requestId } : {}),
  };
}
function unit(order: Record<string, unknown>, job: PaymentOrder): Record<string, unknown> {
  if (
    order.intent !== 'CAPTURE' ||
    !Array.isArray(order.purchase_units) ||
    order.purchase_units.length !== 1
  )
    throw new ProviderError('invalid');
  const value = record(order.purchase_units[0]);
  const amount = record(value.amount);
  if (
    value.reference_id !== job.id ||
    value.custom_id !== job.id ||
    amount.currency_code !== 'USD' ||
    amount.value !== job.amount
  )
    throw new ProviderError('invalid');
  return value;
}
export async function createOrder(
  env: ServiceEnv,
  job: Job,
): Promise<{ id: string; approval: string; payee: string }> {
  const token = await access(env, job.payment_environment);
  const order = await remoteJson(
    await remote(`${api(job.payment_environment)}/v2/checkout/orders`, {
      method: 'POST',
      headers: headers(token, `create-${job.id}`),
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: job.id,
            custom_id: job.id,
            description: `Talember: one 15-second 720p video${job.payment_environment === 'sandbox' ? ' (sandbox)' : ''}`,
            ...(job.payment_environment === 'live' ? { payee: { merchant_id: env.PAYPAL_LIVE_MERCHANT_ID } } : {}),
            amount: { currency_code: 'USD', value: job.amount },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              brand_name: 'Talember',
              landing_page: 'GUEST_CHECKOUT',
              user_action: 'PAY_NOW',
              shipping_preference: 'NO_SHIPPING',
              return_url: `${job.origin}/create?payment=return`,
              cancel_url: `${job.origin}/create?payment=cancel`,
            },
          },
        },
      }),
    }),
  );
  const id = identifier(order.id);
  const purchase = unit(order, job);
  const payee = identifier(record(purchase.payee).merchant_id);
  if (job.payment_environment === 'live' && payee !== env.PAYPAL_LIVE_MERCHANT_ID)
    throw new ProviderError('invalid');
  if (
    !['CREATED', 'PAYER_ACTION_REQUIRED', 'APPROVED'].includes(String(order.status)) ||
    !Array.isArray(order.links)
  )
    throw new ProviderError('invalid');
  const link = order.links.map(record).find((l) => l.rel === 'payer-action' || l.rel === 'approve');
  if (!link || typeof link.href !== 'string' || link.method !== 'GET')
    throw new ProviderError('invalid');
  const approval = new URL(link.href);
  if (
    approval.origin !== approvalOrigin(job.payment_environment) ||
    approval.pathname !== '/checkoutnow' ||
    approval.searchParams.get('token') !== id ||
    [...approval.searchParams.keys()].some((k) => k !== 'token') ||
    approval.username ||
    approval.password ||
    approval.hash
  )
    throw new ProviderError('invalid');
  return { id, approval: approval.href, payee };
}
export async function inspectOrder(
  env: ServiceEnv,
  job: PaymentOrder,
): Promise<{ status: string; capture: string | null }> {
  const token = await access(env, job.payment_environment);
  const order = await remoteJson(
    await remote(`${api(job.payment_environment)}/v2/checkout/orders/${identifier(job.order_id)}`, {
      headers: headers(token),
    }),
  );
  if (order.id !== job.order_id) throw new ProviderError('invalid');
  const purchase = unit(order, job);
  if (record(purchase.payee).merchant_id !== job.payee_id) throw new ProviderError('invalid');
  if (order.status !== 'COMPLETED') return { status: String(order.status), capture: null };
  const payments = record(purchase.payments);
  if (!Array.isArray(payments.captures) || payments.captures.length !== 1)
    throw new ProviderError('invalid');
  const capture = record(payments.captures[0]);
  const amount = record(capture.amount);
  if (capture.final_capture !== true || amount.currency_code !== 'USD' || amount.value !== job.amount)
    throw new ProviderError('invalid');
  if (capture.status === 'PENDING') return { status: 'PENDING', capture: null };
  if (capture.status !== 'COMPLETED') throw new ProviderError('invalid');
  // The capture is obtained within this authenticated order, never from a browser claim.
  return { status: 'COMPLETED', capture: identifier(capture.id) };
}
export async function captureOrder(env: ServiceEnv, job: Job): Promise<void> {
  const token = await access(env, job.payment_environment);
  const response = await remote(`${api(job.payment_environment)}/v2/checkout/orders/${identifier(job.order_id)}/capture`, {
    method: 'POST',
    headers: headers(token, `capture-${job.id}`),
    body: '{}',
  });
  // All capture responses, including an already-captured conflict, are reconciled by
  // fetching the saved order. The POST body alone never grants generation authority.
  await response.body?.cancel();
  if (!response.ok && response.status !== 422 && response.status !== 409)
    throw new ProviderError('retry');
}
