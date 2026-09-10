import { bounded, ProviderError, remoteJson } from './security';

// Exact account-level rejection only. A generic 402/403, transport failure or
// acknowledged request never establishes permission to purchase a replacement.
export class FundingError extends ProviderError {
  constructor(public readonly submissionRejected = false) { super('retry'); }
}
export async function falJson(response: Response, submission = false): Promise<Record<string, unknown>> {
  if (response.status !== 403) return remoteJson(response);
  let exhausted = false;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(await bounded(response.body, 4096)));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const detail = value as Record<string, unknown>;
      exhausted = Object.keys(detail).length === 1 && typeof detail.detail === 'string' &&
        /^User is locked\. Reason: Exhausted balance\. Top up your balance at fal\.ai\/dashboard\/billing\.?$/.test(detail.detail);
    }
  } catch { /* Neither private response content nor parser errors enter logs. */ }
  if (exhausted) throw new FundingError(submission);
  throw new ProviderError('retry');
}
