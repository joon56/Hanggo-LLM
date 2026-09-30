import OpenAI, { toFile } from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import type { z } from 'zod';
import { OwnerExtraction, OWNER_INSTRUCTIONS, createOwnerService } from './owner-service.ts';
import { BriefExtraction, BRIEF_INSTRUCTIONS, createBriefService } from './brief-service.ts';
import { ShelterExtraction, SHELTER_INSTRUCTIONS, createShelterService } from './shelter-service.ts';
import { Extraction, createNoteService, maskPii } from './service.ts';
import type { Config } from './config.ts';
import { NOTE_INSTRUCTIONS } from './prompts.ts';

export function createOpenAIServices(config: Config) {
  // A missing key leaves the local UI usable; routes fail closed until explicitly enabled.
  const client = new OpenAI({ apiKey: config.apiKey || 'disabled', timeout: config.timeoutMs, maxRetries: 0 });
  async function structured(schema: z.ZodType, name: string, instructions: string, input: unknown, repair: string, signal?: AbortSignal) {
    const response = await client.responses.create({ model: config.textModel, store: false, temperature: 0, max_output_tokens: 10000,
      instructions: `${instructions}\n${repair ? `검증 재시도: ${repair}` : ''}`,
      input: [{ role: 'user', content: JSON.stringify(input) }], text: { format: zodTextFormat(schema, name) },
    }, { signal });
    const output = response.output.flatMap(item => item.type === 'message' ? item.content.flatMap(content => content.type === 'output_text' ? [content.text] : []) : []).join('');
    try {
      const raw: unknown = JSON.parse(output);
      // Preserve risk hints, but incomplete responses must never become approved drafts.
      const rejected = response.status !== 'completed' || response.output.some(item => item.type === 'message' && ((item.status && item.status !== 'completed') || item.content.some(content => content.type === 'refusal')));
      if (rejected && raw && typeof raw === 'object') return { safetyFlags: (raw as { safetyFlags?: unknown }).safetyFlags };
      return rejected ? null : raw;
    } catch { return null; }
  }
  const owner = createOwnerService({ model: config.textModel, extract: (input, repair, signal) => structured(OwnerExtraction, 'owner_log', OWNER_INSTRUCTIONS, input, repair, signal) });
  const brief = createBriefService({ model: config.textModel, extract: (input, repair, signal) => structured(BriefExtraction, 'owner_brief', BRIEF_INSTRUCTIONS, input, repair, signal) });
  const shelter = createShelterService({ model: config.textModel, extract: (input, repair, signal) => structured(ShelterExtraction, 'shelter_profile', SHELTER_INSTRUCTIONS, input, repair, signal) });
  const service = createNoteService({ model: config.textModel, extract: async (text, repair, signal) => {
    const response = await client.responses.create({
      model: config.textModel, store: false, temperature: 0, max_output_tokens: 6000,
      instructions: `${NOTE_INSTRUCTIONS}
${repair ? `검증 재시도 지침: ${repair}` : ''}`,
      input: [{ role: 'user', content: JSON.stringify({ trainer_notes: text }) }],
      text: { format: zodTextFormat(Extraction, 'session_notes') },
    }, { signal });
    // Validate in the service so valid risk fields survive malformed sibling fields.
    const output = response.output.flatMap(item => item.type === 'message'
      ? item.content.flatMap(content => content.type === 'output_text' ? [content.text] : []) : []).join('');
    try {
      const raw: unknown = JSON.parse(output);
      const rejected = response.status !== 'completed' || response.output.some(item => item.type === 'message' && ((item.status && item.status !== 'completed') || item.content.some(content => content.type === 'refusal')));
      if (rejected && typeof raw === 'object' && raw !== null)
        return { ...raw, items: [] };
      return rejected ? null : raw;
    } catch { return null; }
  } });
  return { generate: service.generate, generateOwner: owner.generate, generateBrief: brief.generate, generateShelter: shelter.generate,
    async transcribe(buffer: Buffer, filename: string, petName: string, signal?: AbortSignal) {
      const file = await toFile(buffer, filename);
      const response = await client.audio.transcriptions.create({ file, model: config.sttModel, language: 'ko', response_format: 'json',
        prompt: `반려동물의 일상 기록, 상담 후 요약 또는 보호소 관찰 메모. 용어: 앉아, 기다려, 켄넬, 하네스, 배변패드, 노즈워크. 반려동물 이름: ${maskPii(petName)}.` }, { signal });
      return response.text;
    },
  };
}
