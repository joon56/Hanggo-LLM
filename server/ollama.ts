import { z } from 'zod';
import type { Config } from './config.ts';
import { Extraction, createNoteService } from './service.ts';
import { NOTE_INSTRUCTIONS } from './prompts.ts';
import { OwnerExtraction, OWNER_INSTRUCTIONS, createOwnerService } from './owner-service.ts';
import { BriefExtraction, BRIEF_INSTRUCTIONS, createBriefService } from './brief-service.ts';
import { ShelterExtraction, SHELTER_INSTRUCTIONS, createShelterService } from './shelter-service.ts';
import { assertLocalModel } from './local-model.ts';
import { isBriefChange } from '../src/domain/brief.ts';
import { splitNoteSentences } from '../src/domain/notes.ts';

// No cloud fallback: all inference stays at the validated loopback origin.
export function createOllamaServices(config: Config) {
  async function structured(schema: z.ZodType, instructions: string, input: unknown, repair: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    await assertLocalModel(config, combined);
    const format = z.toJSONSchema(schema);
    const response = await fetch(`${config.ollamaBaseUrl}/api/chat`, {
      method: 'POST', redirect: 'error', signal: combined, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.textModel, stream: false, think: false, truncate: false, shift: false,
        format, keep_alive: '5m',
        options: { temperature: 0, seed: 42, num_ctx: config.ollamaContextSize, num_predict: 4096, repeat_penalty: 1, presence_penalty: 0 },
        messages: [{ role: 'system', content: `${instructions}\n출력 JSON 스키마: ${JSON.stringify(format)}\n${repair ? `검증 재시도: ${repair}` : ''}` }, { role: 'user', content: JSON.stringify(input) }],
      }),
    });
    if (!response.ok) throw new Error(`Local model unavailable (${response.status}).`);
    // Bound even a misconfigured local server's response before JSON parsing.
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Local model returned no body.');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) throw new Error('Local model response too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let raw: unknown;
    try { raw = JSON.parse(result.message?.content); } catch { return null; }
    if (!result.done || result.done_reason !== 'stop' || result.error) {
      // Invalid/incomplete sibling fields never erase independently valid risks.
      const risk = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
      return { safetyFlags: risk.safetyFlags, methodReview: risk.methodReview };
    }
    return raw;
  }
  const note = createNoteService({ model: config.textModel, extract: (text, repair, signal) => {
    const quotes = [...new Set(splitNoteSentences(text))];
    // The grammar copies source sentences verbatim instead of letting the
    // model rewrite Korean spacing or numbers. Long sentences keep the
    // existing bounded-substring extraction and final validation path.
    const schema = quotes.length && quotes.every(quote => quote.length <= 2000)
      ? Extraction.extend({ items: z.array(Extraction.shape.items.element.extend({ sourceQuote: z.enum(quotes) })).min(1).max(100) }) : Extraction;
    return structured(schema, `${NOTE_INSTRUCTIONS}\n출처가 없는 짧은 메모·일상 진술·건강 증상은 follow_up입니다. observation은 훈련사의 직접 관찰이 명시된 경우입니다. 증상과 확인할 내용은 follow_up에 보존하세요. sourceQuote의 띄어쓰기·숫자·문장 부호를 그대로 복사하세요. 체벌·강압 행위는 methodReview에 표시합니다. 행위만으로 원문에 없는 통증이나 건강 증상을 추측해 safetyFlags에 추가하지 마세요.`, { trainer_notes: text }, repair, signal);
  } });
  const owner = createOwnerService({ model: config.textModel, extract: (input, repair, signal) => structured(OwnerExtraction, `${OWNER_INSTRUCTIONS}\n발생 시점이 없으면 timeHint=null, 지속 시간이 없으면 durationMin=null입니다. now를 발생 시각으로 복사하지 마세요. 모르는 값을 0이나 무관한 원문으로 채우지 마세요. excretionKinds의 pee는 소변, poop은 대변이며 배변 외 사건에서는 []입니다. 음식 외 사건의 isTreat는 null입니다.`, input, repair, signal) });
  const brief = createBriefService({ model: config.textModel, extract: (input, repair, signal) => {
    const choices = (ids: string[], max: number) => ids.length ? z.array(z.enum(ids)).max(max) : z.array(z.string()).max(0);
    const ids = input.facts.map(fact => fact.id);
    const priorDays = Number(input.facts.find(fact => fact.id === 'record-days')?.previousValue);
    const changes = input.facts.filter(fact => isBriefChange(fact, input.period.daysWithRecords, priorDays)).map(fact => fact.id);
    // Constrained decoding prevents prose or invented IDs; the shared service
    // still validates IDs, changes, duplicates and source facts afterward.
    const schema = BriefExtraction.extend({ summary: choices(ids, 3), changes: choices(changes, 10), questionsForOwner: choices(ids, 3) });
    return structured(schema, BRIEF_INSTRUCTIONS, input, repair, signal);
  } });
  const shelter = createShelterService({ model: config.textModel, extract: (input, repair, signal) => structured(ShelterExtraction, `${SHELTER_INSTRUCTIONS}\n마침표로 구분된 여러 문장을 하나의 sourceQuote에 합치지 마세요. 행동 관찰과 무관한 연락처는 제외하세요. category는 기록 대상 동물의 종이 아니라 관찰 주제입니다. people=사람과의 관계, dogs=다른 개와의 관계, cats=고양이와의 관계, food=음식·간식입니다.`, input, repair, signal) });
  return { generate: note.generate, generateOwner: owner.generate, generateBrief: brief.generate, generateShelter: shelter.generate };
}
