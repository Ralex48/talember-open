import { savedVideoDirection } from './director';
import { copy } from './i18n';
import { MAX_SCRIPT, type Job, type ServiceEnv } from './types';
import { ProviderError, PublicError } from './security';
import { continuity } from './continuity';
import { fontSupports } from './greeting-fonts';

export function selectedSource(job: Job): string | null {
  return job.selected === 'original' ? job.original_key
    : job.selected === 'corrected' ? job.corrected_key : null;
}
export function proposedScript(job: Job): string {
  const direction = savedVideoDirection(JSON.parse(job.video_direction_json!));
  const t = copy(job.locale);
  // Saved older directions are displayed without purchasing a replacement or
  // changing their original language. New direction fields use the chosen locale.
  const fields = 'scene' in direction
    ? [[t.story, job.story], [t.scriptAction, direction.scene],
        [t.scriptCamera, direction.composition], [t.scriptSubjects, direction.likeness]]
    : [[t.scriptStyle, direction.style], [t.scriptSubjects, direction.subjects],
        [t.scriptEnvironment, direction.environment], [t.scriptAction, direction.action],
        [t.scriptCamera, direction.camera], [t.scriptAudio, direction.audio]];
  // This visible initial proposal contains the exact customer words once. Later
  // saves/approval may edit or remove them; dispatch never appends them again.
  if (job.closing_wish && job.overlay_version !== 1) fields.push([t.scriptWish, `${t.scriptWishInstruction}\n${job.closing_wish}`]);
  const text = fields.map(([label, value]) => `${label}: ${value ?? ''}`).join('\n\n') + '\n\n' + continuity[job.locale];
  if (!text.trim() || text.length > MAX_SCRIPT) throw new ProviderError('invalid');
  return text;
}
export async function reviewScript(
  env: ServiceEnv, job: Job, text: string, revision: number, approve: boolean, wish: string | null = job.closing_wish,
  effect: string = job.greeting_effect ?? 'none',
  color: string = job.greeting_color ?? 'white',
  font: string = job.greeting_font ?? 'classic',
): Promise<Job> {
  const t = copy(job.locale);
  if (!fontSupports(font, wish ?? '')) throw new PublicError(400, t.scriptInvalid);
  if (!['none', 'hearts', 'fireworks', 'celebration'].includes(effect)) throw new PublicError(400, t.scriptInvalid);
  if (!['white', 'gold', 'pink', 'multicolor'].includes(color)) throw new PublicError(400, t.scriptInvalid);
  if (wish !== null && (wish.length > 80 || /\p{C}/u.test(wish)))
    throw new PublicError(400, t.scriptInvalid);
  if (text.trim().length < 10 || text.length > MAX_SCRIPT || !Number.isSafeInteger(revision) || revision < 1)
    throw new PublicError(400, t.scriptInvalid);
  const source = selectedSource(job);
  if (!source || !(await env.TALEMBER_PRIVATE_MEDIA.head(source)))
    throw new PublicError(409, t.scriptUnavailable);
  const now = Date.now();
  const saved = await env.TALEMBER_DB.prepare(
    `UPDATE creation_jobs SET video_script = ?, closing_wish = ?, greeting_effect = ?, greeting_color = ?, greeting_font = ?, video_script_revision = video_script_revision + 1,
    video_script_approved_at = ?, video_script_approved_revision = ?, next_at = ?, updated_at = ?
    WHERE id = ? AND phase = 'video_directed' AND video_script IS NOT NULL
    AND video_script_revision = ? AND video_script_approved_at IS NULL
    AND video_request_id IS NULL AND video_submitted_at IS NULL AND lease_until <= ?
    AND expires_at > ? AND content_expires_at > ? AND content_deleted_at IS NULL
    AND video_script_source_key = ? AND video_script_source_key = CASE selected
      WHEN 'original' THEN original_key WHEN 'corrected' THEN corrected_key END
    AND references_json IS script_references_json
    AND paid_at IS NOT NULL AND capture_id IS NOT NULL
    AND EXISTS (SELECT 1 FROM creation_payments p WHERE p.job_id = creation_jobs.id
      AND p.capture_id = creation_jobs.capture_id AND p.order_id = creation_jobs.order_id)
    RETURNING *`,
  ).bind(text, job.overlay_version === 1 ? wish : job.closing_wish, job.overlay_version === 1 ? effect : job.greeting_effect, job.overlay_version === 1 ? color : job.greeting_color, job.overlay_version === 1 ? font : job.greeting_font, approve ? now : null, approve ? revision + 1 : null, now, now,
    job.id, revision, now, now, now, source).first<Job>();
  if (saved) return saved;
  const current = await env.TALEMBER_DB.prepare('SELECT * FROM creation_jobs WHERE id = ?')
    .bind(job.id).first<Job>();
  // An identical approval replay observes the saved approval; it never changes
  // the prompt, selection or provider checkpoint and makes no external call.
  if (approve && current?.video_script_approved_at &&
    current.video_script_approved_revision === revision + 1 &&
    current.video_script === text && current.video_script_source_key === source &&
    (job.overlay_version !== 1 || (current.closing_wish === wish && current.greeting_effect === effect && current.greeting_color === color && current.greeting_font === font)))
    return current;
  throw new PublicError(409, t.scriptConflict);
}
