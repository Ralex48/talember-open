import type { Job } from './types';
import { ProviderError } from './security';
export interface Reference { photo: number; started?: number; request?: string; key?: string;
  model?: 'openai/gpt-image-2.5-sunburst' | 'openai/gpt-image-2.5-flare';
  reviewFirst?: boolean;
  reviewAfter?: boolean;
  styleRequired?: boolean; styleStarted?: number;
  style?: { description: string; request: string; source: string; sha256: string } }
export function references(job: Job): Reference[] {
  if (job.references_json === null) return [];
  const rows: unknown = JSON.parse(job.references_json);
  if (!Array.isArray(rows) || rows.length > 3) throw new ProviderError('invalid');
  for (const [i, row] of rows.entries()) {
    if (!row || row.photo !== i + 2 || (row.key && row.key !== `creation/${job.id}/reference-${i + 2}.png`))
      throw new ProviderError('invalid');
  }
  return rows as Reference[];
}
export function referenceKeys(job: Job): string[] {
  const source = job.selected === 'corrected' ? job.corrected_key : job.original_key;
  if (!source) throw new ProviderError('invalid');
  const rows = references(job);
  if (rows.some(row => !row.key)) throw new ProviderError('invalid');
  return [source, ...rows.map(row => row.key!)];
}
