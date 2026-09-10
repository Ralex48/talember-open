import { describe, expect, it } from 'vitest';
import { falJson, FundingError } from '../../app/funding';

describe('funding rejection classification', () => {
  const detail = 'User is locked. Reason: Exhausted balance. Top up your balance at fal.ai/dashboard/billing';
  it('limits automatic resubmission permission to a definitive account rejection', async () => {
    await expect(falJson(Response.json({ detail }, { status: 403 }), true))
      .rejects.toMatchObject({ submissionRejected: true });
    await expect(falJson(Response.json({ detail }, { status: 403 })))
      .rejects.toMatchObject({ submissionRejected: false });
    for (const response of [Response.json({ detail: 'Forbidden' }, { status: 403 }),
      Response.json({ detail, request_id: 'already-accepted' }, { status: 403 }),
      Response.json({ detail }, { status: 500 }), Response.json({ detail }, { status: 402 })]) {
      try { await falJson(response, true); throw new Error('Expected rejection'); }
      catch (error) { expect(error).not.toBeInstanceOf(FundingError); }
    }
  });
});
