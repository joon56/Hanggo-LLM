import type { Generation, NoteMode } from './notes.ts';

export type Pet = { id: string; name: string; nicknames: string[] };
export type ServiceResult<T> = { draft: T; fallbackUsed: boolean; requestId: string; latencyMs: number; model: string; warnings: string[] };
export type OwnerSourceKind = 'nl_log_text' | 'nl_log_voice';
export type EventType = 'bark' | 'feeding' | 'walk' | 'excretion' | 'rest' | 'activity' | 'training' | 'other_behavior' | 'health_observation' | 'other';
export type EventTrigger = 'doorbell' | 'delivery' | 'visitor' | 'stranger' | 'other_dog' | 'other_animal' | 'noise' | 'left_alone' | 'owner_return' | 'food' | 'unknown' | 'other';
export type EventOutcome = 'stopped' | 'reduced' | 'continued' | 'escalated' | 'unknown';
export type OwnerInput = { text: string; pets: Pet[]; now: string; timeZone: string; sourceKind: OwnerSourceKind };
export type OwnerEvent = {
  id: string; petId: string | null; type: EventType; occurredAt: string | null; timeHint: string | null;
  durationMin: number | null; trigger: EventTrigger | null; intervention: string | null; outcome: EventOutcome | null;
  details: { amountText: string | null; isTreat: boolean | null; excretionKinds: ('pee' | 'poop' | 'unknown')[]; placeText: string | null };
  sourceQuote: string; edited: boolean;
};
export type OwnerDraft = {
  id: string; sourceText: string; sourceKind: OwnerSourceKind; pets: Pet[]; now: string; timeZone: string;
  events: OwnerEvent[]; safetyFlags: string[]; clarification: string | null; mode: NoteMode; generation?: Generation;
};
export type SavedOwnerLog = { id: string; draft: OwnerDraft; savedAt: string };
export type Fact = { id: string; label: string; value: number | string; unit: string; previousValue: number | string | null; refs: string[] };
export type ReferencedText = { text: string; refs: string[] };
export type BriefInput = {
  pet: Pet; records: SavedOwnerLog[]; now: string; timeZone: string;
  previousSession?: { date: string; items: { id: string; text: string; category: string }[] };
};
export type BriefDraft = {
  id: string; petId: string; period: { from: string; to: string; daysWithRecords: number };
  facts: Fact[]; summary: ReferencedText[]; changes: ReferencedText[]; questionsForOwner: ReferencedText[];
  previousTasks: ReferencedText[]; cautions: ReferencedText[]; dataGaps: string[]; safetyFlags: string[];
  mode: NoteMode; generation?: Generation;
};
export type ShelterMemo = { id: string; date: string; role: 'staff' | 'volunteer'; text: string };
export type ShelterAnimal = { id: string; name: string; species: 'dog' | 'cat'; ageMonths: number | null };
export type ShelterInput = { animal: ShelterAnimal; memos: ShelterMemo[] };
export type Sociality = 'observed_positive' | 'observed_caution' | 'mixed' | 'unknown';
export type EvidenceText = { text: string; sourceQuote: string; memoId: string; memoDate: string };
export type ShelterObservation = EvidenceText & {
  id: string; category: 'people' | 'dogs' | 'cats' | 'walk' | 'alone' | 'handling' | 'food' | 'noise' | 'house' | 'other';
  valence: 'positive' | 'caution' | 'neutral'; edited: boolean;
};
export type ShelterDraft = {
  id: string; animal: ShelterAnimal; memos: ShelterMemo[]; observations: ShelterObservation[];
  sociability: { people: Sociality; dogs: Sociality; cats: Sociality };
  likes: EvidenceText[]; cautions: EvidenceText[]; unknowns: string[];
  adopterIntro: { text: string; cautionLine: string }; safetyFlags: string[];
  mode: NoteMode; generation?: Generation;
};
export type SavedShelterProfile = { id: string; draft: ShelterDraft; approvedAt: string; approvedBy: string };
export type FeatureFlags = { ownerLog: boolean; brief: boolean; shelter: boolean };
