import type { z } from 'zod';
import type { Config } from './config.ts';
import { createNoteService } from './service.ts';
import { createOwnerService } from './owner-service.ts';
import { BRIEF_INSTRUCTIONS, createBriefService } from './brief-service.ts';
import { createShelterService } from './shelter-service.ts';
import { createStructuredClient } from './api-structured.ts';
import type { ApiUsage, StructuredClient } from './api-types.ts';
import { API_NOTE_INSTRUCTIONS, API_OWNER_INSTRUCTIONS, API_SHELTER_INSTRUCTIONS, BriefChoice, NoteChoice, OwnerChoice, ShelterChoice, briefRequest, mapNoteChoice, mapOwnerChoice, mapShelterChoice, noteRequest, ownerRequest, shelterRequest } from './api-mappers.ts';

type Options = { client?: StructuredClient; onUsage?: (usage: ApiUsage) => void };
// Text features only; speech and video keep their local runtimes in this phase.
export function createApiServices(config: Config, { client = createStructuredClient(config), onUsage }: Options = {}) {
  async function call(model: string, system: string, input: unknown, schema: z.ZodType, repair: string, signal?: AbortSignal) {
    const started = Date.now(), deadline = AbortSignal.timeout(config.apiTimeoutMs);
    const result = await client({ model, system: repair ? `${system}\n검증 재시도: ${repair}` : system, input, schema, signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
    onUsage?.({ model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: Date.now() - started });
    return result.json;
  }
  const note = createNoteService({ model: config.apiTextModel, extract: async (text, repair, signal) => {
    const { units, input } = noteRequest(text);
    return mapNoteChoice(units, await call(config.apiTextModel, API_NOTE_INSTRUCTIONS, input, NoteChoice, repair, signal));
  } });
  const owner = createOwnerService({ model: config.apiShortModel, extract: async (masked, repair, signal) => {
    const { units, input } = ownerRequest(masked);
    return mapOwnerChoice(masked.text, units, await call(config.apiShortModel, API_OWNER_INSTRUCTIONS, input, OwnerChoice, repair, signal));
  } });
  const brief = createBriefService({ model: config.apiTextModel, extract: (draft, repair, signal) => call(config.apiTextModel, BRIEF_INSTRUCTIONS, briefRequest(draft), BriefChoice, repair, signal) });
  const shelter = createShelterService({ model: config.apiTextModel, extract: async (masked, repair, signal) => {
    const { memos, input } = shelterRequest(masked);
    return mapShelterChoice(memos, await call(config.apiTextModel, API_SHELTER_INSTRUCTIONS, input, ShelterChoice, repair, signal));
  } });
  return { generate: note.generate, generateOwner: owner.generate, generateBrief: brief.generate, generateShelter: shelter.generate };
}
