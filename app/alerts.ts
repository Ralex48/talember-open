import type { ServiceEnv } from './types';

// Durable, content-free outbox. A send timeout may produce a duplicate alert,
// but it must never cause a generation or lose the pending notification.
export async function deliverAlerts(env: ServiceEnv): Promise<void> {
  if (!env.TALEMBER_ALERT_EMAIL || !env.TALEMBER_ALERT_FROM || !env.TALEMBER_ALERT_TO) return;
  const now = Date.now();
  const due = await env.TALEMBER_DB.prepare(`UPDATE creation_provider_incidents SET next_notify_at = ?
    WHERE job_id IN (SELECT job_id FROM creation_provider_incidents
      WHERE notified_at IS NULL AND next_notify_at <= ? ORDER BY detected_at LIMIT 1)
    RETURNING job_id`).bind(now + 5 * 60_000, now).first<{ job_id: string }>();
  if (!due) return;
  try {
    await env.TALEMBER_ALERT_EMAIL.send({
      from: env.TALEMBER_ALERT_FROM, to: env.TALEMBER_ALERT_TO,
      subject: 'Talember: fal.ai balance needs attention',
      text: 'Talember detected an explicit exhausted-balance rejection from fal.ai. A paid story was delayed. Check fal.ai billing and the Talember operations status. Requests confirmed rejected before acceptance are retried automatically every five minutes. Existing accepted requests retain their identity; uncertain outcomes require review. Do not charge the customer again.',
    });
    await env.TALEMBER_DB.prepare('UPDATE creation_provider_incidents SET notified_at = ? WHERE job_id = ?')
      .bind(Date.now(), due.job_id).run();
  } catch { console.warn(JSON.stringify({ event: 'operator_alert_delivery_failed' })); }
}
