import { z } from 'zod';
import type { NoteLine, NoteViolation, RawNote } from '../../src/domain/coaching-note.ts';
import { SAFETY_LABELS } from '../../src/domain/notes.ts';

const REPAIR_MAX_TOKENS = 1024;
const NOTE_INSTRUCTIONS = `너는 반려동물 행동 훈련사의 상담 기록을 정리하는 보조다. 입력은 보호자와 훈련사의 화상 상담 전사다.

규칙
1. 전사에 있는 내용만 정리한다. 말하지 않은 사실, 원인, 조언, 과제를 만들지 않는다.
2. 모든 문장에 근거 발화 id를 evidence로 단다. 문장 안에는 id를 쓰지 않는다.
3. 문장은 근거 발화의 낱말을 되도록 그대로 쓴다. 숫자와 이름은 근거 발화에 있는 그대로 쓴다.
4. "않았다", "없다", "못했다" 같은 부정 표현을 뒤집지 않는다. 누가 말했는지 바꾸지 않는다.
5. 진단, 치료, 완치, 질환명 추정, 효과 보장, 개체에 붙이는 낙인을 쓰지 않는다. 측정값을 개선으로 단정하지 않는다.
6. guardianReports는 보호자가 말한 내용만, guidance와 trainerObservations는 훈련사가 말한 내용만 담고, 그 사람의 발화를 근거로 단다. 맞장구나 인사는 넣지 않는다. 훈련사가 한 조언과 설명, 하지 말라고 한 것은 과제와 겹쳐도 guidance에 빠짐없이 담는다.
7. tasks에는 훈련사가 보호자에게 해 달라고 실제로 내준 과제만 담는다. 설명만 한 연습, 나중에 정하기로 한 일, 주의 사항은 과제가 아니다. 과제를 정하지 않았으면 빈 배열이다. text에는 무엇을 어떻게 하는지 행동을 쓴다. "해 주세요"만 옮기지 말고 앞 발화의 연습 내용을 합쳐 적고 그 발화들을 모두 evidence로 단다. 성공 기준은 훈련사가 잘 됐다고 볼 기준을 말한 경우에만 쓴다. 담당, 횟수, 기한, 성공 기준이 전사에 없으면 null이다. 사람이 여럿이면 과제를 나눠 담당을 각각 적는다.
8. behaviors는 문제 행동마다 하나씩 만든다. 상황과 계기, 행동 양상과 빈도와 지속 시간, 보호자 대응과 이후 반응을 나눈다. 전사에 없는 항목은 unknown에 적는다.
9. 체벌이나 강압적 방법이 언급되면 methodReview를 true로 한다.
10. 통증, 구토, 출혈, 절뚝거림, 갑작스러운 공격성, 호흡 곤란, 발작, 설사, 식욕 저하, 물림이 언급되면 safetyFlags에 넣는다.
11. summary는 핵심 3문장 이내다. 짧게 쓴다. 한 문장에 한 가지 사실만 쓴다.`;

const SUMMARY_INSTRUCTIONS = `너는 반려동물 행동 훈련사의 상담 기록을 정리하는 보조다. 입력은 이미 정리되어 근거 id가 붙은 문장 목록이다.
목록에 있는 내용만 써서 핵심 3문장 이내로 요약한다. 새 사실, 진단, 효과 보장을 쓰지 않는다. 숫자와 이름은 그대로 쓴다. 각 문장에 입력에 있는 근거 id를 evidence로 단다. 문장 안에는 id를 쓰지 않는다.`;

function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
const label = ({ evidence }: NoteLine) => evidence.kind === 'moment' ? '훈련사 메모' : evidence.speaker === 'guardian' ? '보호자' : '훈련사';

function claimSchema(ids: string[]) {
  return { type: 'object', properties: { text: { type: 'string', maxLength: 300 }, evidence: { type: 'array', minItems: 1, maxItems: 6, items: { enum: ids } } }, required: ['text', 'evidence'], additionalProperties: false };
}

export function buildNoteRequest(petName: string, lines: NoteLine[], problems: NoteViolation[] = []) {
  const claim = claimSchema(lines.map(line => line.alias));
  const claims = { type: 'array', maxItems: 12, items: claim };
  const nullableText = { type: ['string', 'null'], maxLength: 100 };
  const jsonSchema = { type: 'object', additionalProperties: false,
    required: ['summary', 'concerns', 'behaviors', 'guardianReports', 'trainerObservations', 'guidance', 'tasks', 'followUps', 'safetyFlags', 'methodReview'],
    properties: {
      summary: { type: 'array', maxItems: 3, items: claim }, concerns: claims,
      behaviors: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['title', 'context', 'behavior', 'response', 'unknown'],
        properties: { title: { type: 'string', maxLength: 60 }, context: claims, behavior: claims, response: claims, unknown: { type: 'array', maxItems: 4, uniqueItems: true, items: { enum: ['trigger', 'frequency', 'duration', 'response'] } } } } },
      guardianReports: claims, trainerObservations: claims, guidance: claims,
      tasks: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['text', 'who', 'frequency', 'until', 'successCriteria', 'evidence'],
        properties: { text: { type: 'string', maxLength: 300 }, who: nullableText, frequency: nullableText, until: nullableText, successCriteria: nullableText, evidence: claim.properties.evidence } } },
      followUps: claims, safetyFlags: { type: 'array', items: { enum: SAFETY_LABELS } }, methodReview: { type: 'boolean' },
    } };
  const transcript = lines.map(line => `[${line.alias} ${formatTime(line.evidence.startMs)} ${label(line)}] ${line.evidence.quote}`).join('\n');
  const repair = problems.length ? `\n\n이전 결과에서 아래 문장이 규칙을 어겼다. 이 문장들만 규칙에 맞게 고쳐서 원래 항목에 담고, 나머지 항목은 모두 빈 배열로 둔다. 고칠 수 없는 문장은 뺀다.\n${problems.map(item => `- ${item.section}: "${item.text}" (${item.reasons.join(' ')})`).join('\n')}` : '';
  return { jsonSchema, system: NOTE_INSTRUCTIONS, user: `반려동물: ${petName}\n\n전사:\n${transcript}${repair}`, maxTokens: problems.length ? REPAIR_MAX_TOKENS : 4096 };
}

export function buildSummaryRequest(petName: string, statements: { text: string; aliases: string[] }[]) {
  const ids = [...new Set(statements.flatMap(item => item.aliases))];
  const jsonSchema = { type: 'object', additionalProperties: false, required: ['summary'], properties: { summary: { type: 'array', maxItems: 3, items: claimSchema(ids) } } };
  const list = statements.map(item => `[${item.aliases.join(',')}] ${item.text}`).join('\n');
  return { jsonSchema, system: SUMMARY_INSTRUCTIONS, user: `반려동물: ${petName}\n\n문장 목록:\n${list}`, maxTokens: 1024 };
}

const rawClaim = z.object({ text: z.string(), evidence: z.array(z.string()) });
export const RawNoteSchema: z.ZodType<RawNote> = z.object({
  summary: z.array(rawClaim), concerns: z.array(rawClaim),
  behaviors: z.array(z.object({ title: z.string(), context: z.array(rawClaim), behavior: z.array(rawClaim), response: z.array(rawClaim), unknown: z.array(z.enum(['trigger', 'frequency', 'duration', 'response'])) })),
  guardianReports: z.array(rawClaim), trainerObservations: z.array(rawClaim), guidance: z.array(rawClaim),
  tasks: z.array(z.object({ text: z.string(), who: z.string().nullable(), frequency: z.string().nullable(), until: z.string().nullable(), successCriteria: z.string().nullable(), evidence: z.array(z.string()) })),
  followUps: z.array(rawClaim), safetyFlags: z.array(z.string()), methodReview: z.boolean(),
});
export const RawSummarySchema = z.object({ summary: z.array(rawClaim) });
