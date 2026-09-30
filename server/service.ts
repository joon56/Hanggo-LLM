import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createDraft, createManualDraft, getReviewSignals, validateDraft } from '../src/domain/notes.ts';
import type { Draft, SourceKind } from '../src/domain/notes.ts';

export const PROMPT_VERSION = 'session-notes@1.0.0';
export const Extraction = z.object({
  items: z.array(z.object({
    category: z.enum(['owner_report', 'observation', 'guidance', 'task', 'follow_up']),
    sourceQuote: z.string().min(1).max(2000),
  }).strict()).min(1).max(100),
  safetyFlags: z.array(z.enum(['통증', '구토', '출혈', '절뚝거림', '갑작스러운 공격성', '호흡 곤란', '발작', '설사', '식욕 저하', '물림'])),
  methodReview: z.boolean(),
}).strict();

export function maskPii(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, match => '*'.repeat(match.length))
    .replace(/(?:\+82[- .]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}|0\d{1,2}[- .]\d{3,4}[- .]\d{4}/g, match => '*'.repeat(match.length))
    .replace(/(?:[가-힣]+(?:특별시|광역시|도|시)\s+)?[가-힣]+(?:시|군|구)\s+[가-힣0-9]+(?:로|길|동)\s*\d+(?:[-\s]\d+)?(?:\s*\d+동\s*\d+호)?/g, match => '*'.repeat(match.length));
}

type Options = { model: string; mode?: 'openai' | 'ollama'; extract: (text: string, repair: string, signal?: AbortSignal) => Promise<unknown> };
export function createNoteService({ model, mode = 'openai', extract }: Options) {
  return {
    async generate(text: string, sourceKind: SourceKind, signal?: AbortSignal) {
      signal?.throwIfAborted();
      const started = Date.now();
      const requestId = randomUUID();
      const base = createDraft(text, sourceKind);
      const masked = maskPii(text);
      let draft: Draft | undefined;
      let repair = '';
      // Accumulate model risk across attempts: repair never lowers a raised flag.
      const flags = new Set(base.safetyFlags);
      let methodReview = base.methodReview;
      for (let attempt = 0; attempt < 2; attempt++) {
        let raw: unknown;
        try { raw = await extract(masked, repair, signal); }
        catch { signal?.throwIfAborted(); break; }
        signal?.throwIfAborted();
        // A malformed item must not erase independently valid model risk signals.
        if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
          const risk = raw as Record<string, unknown>;
          if (Array.isArray(risk.safetyFlags)) for (const value of risk.safetyFlags) {
            const flag = Extraction.shape.safetyFlags.element.safeParse(value);
            if (flag.success) flags.add(flag.data);
          }
          methodReview ||= risk.methodReview === true;
        }
        const parsed = Extraction.safeParse(raw);
        if (!parsed.success) { repair = '출력 스키마와 배열 길이를 지키세요. 원문에 있는 구절만 인용하세요.'; continue; }
        parsed.data.safetyFlags.forEach(flag => flags.add(flag));
        methodReview ||= parsed.data.methodReview;
        const seen = new Set<string>();
        const items = parsed.data.items.map(item => {
          const index = masked.indexOf(item.sourceQuote);
          if (index < 0 || seen.has(item.sourceQuote)) return null;
          seen.add(item.sourceQuote);
          const quote = text.slice(index, index + item.sourceQuote.length);
          return { id: randomUUID(), category: flags.size || methodReview ? (item.category === 'task' ? 'follow_up' as const : item.category) : item.category,
            text: quote, sourceQuote: quote, edited: false };
        });
        if (items.some(item => item === null)) { repair = '존재하지 않거나 중복된 인용이 있습니다. 입력의 정확한 부분 문자열만 한 번씩 인용하세요.'; continue; }
        const candidate: Draft = { ...base, mode, items: items.filter(item => item !== null), safetyFlags: [...flags], methodReview };
        const errors = validateDraft(candidate);
        if (errors.length) { repair = [...new Set(errors)].join(' '); continue; }
        draft = candidate;
        break;
      }
      signal?.throwIfAborted();
      const fallbackUsed = !draft;
      draft ??= { ...createManualDraft(text, sourceKind), safetyFlags: [...flags], methodReview };
      Object.assign(draft, getReviewSignals(draft));
      const latencyMs = Date.now() - started;
      draft.generation = { requestId, model, promptVersion: PROMPT_VERSION, latencyMs, fallbackUsed };
      if (validateDraft(draft).length) throw new Error('Generated draft failed final validation.');
      return { draft, fallbackUsed, requestId, latencyMs, model,
        warnings: fallbackUsed ? ['AI 정리를 완료하지 못해 원문을 추가 확인 항목으로 옮겼습니다. 직접 분류하고 검토해 주세요.'] : [] };
    },
  };
}
