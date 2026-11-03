// Draft note request used to compare models. Step 3 adds validation around this shape.
export const NOTE_SAFETY_FLAGS = ['통증', '구토', '출혈', '절뚝거림', '갑작스러운 공격성', '호흡 곤란', '발작', '설사', '식욕 저하', '물림'] as const;
export type NoteSegment = { id: string; speaker: 'guardian' | 'trainer'; startMs: number; endMs: number; text: string };

const NOTE_INSTRUCTIONS = `너는 반려동물 행동 훈련사의 상담 기록을 정리하는 보조다. 입력은 보호자와 훈련사의 화상 상담 전사다.

규칙
1. 전사에 있는 내용만 정리한다. 말하지 않은 사실, 원인, 조언, 과제를 만들지 않는다.
2. 모든 문장에 근거 발화 id를 evidence로 단다.
3. 숫자와 이름은 근거 발화에 있는 그대로 쓴다.
4. 진단, 치료, 완치, 질환명 추정, 효과 보장, 개체에 붙이는 낙인을 쓰지 않는다. 측정값을 개선으로 단정하지 않는다.
5. guardianReports는 보호자가 말한 내용만, guidance는 훈련사가 안내한 내용만 담는다.
6. tasks에는 훈련사가 내준 과제만 담는다. 과제를 정하지 않았으면 빈 배열이다. 담당, 횟수, 기한이 전사에 없으면 null이다.
7. behaviors는 문제 행동마다 하나씩 만든다. 상황과 계기, 행동 양상과 빈도와 지속 시간, 보호자 대응과 이후 반응을 나눈다. 전사에 없는 항목은 unknown에 적는다.
8. 체벌이나 강압적 방법이 언급되면 methodReview를 true로 한다.
9. 통증, 구토, 출혈, 절뚝거림, 갑작스러운 공격성, 호흡 곤란, 발작, 설사, 식욕 저하, 물림이 언급되면 safetyFlags에 넣는다.
10. summary는 핵심 3문장 이내다. 짧게 쓴다. 한 문장에 한 가지 사실만 쓴다.`;

function formatTime(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function buildNoteRequest(petName: string, segments: NoteSegment[]) {
  const ids = segments.map(segment => segment.id);
  const claim = { type: 'object', properties: { text: { type: 'string', maxLength: 300 }, evidence: { type: 'array', minItems: 1, maxItems: 6, items: { enum: ids } } }, required: ['text', 'evidence'], additionalProperties: false };
  const claims = { type: 'array', maxItems: 12, items: claim };
  const nullableText = { type: ['string', 'null'], maxLength: 100 };
  const jsonSchema = { type: 'object', additionalProperties: false,
    required: ['summary', 'concerns', 'behaviors', 'guardianReports', 'trainerObservations', 'guidance', 'tasks', 'followUps', 'safetyFlags', 'methodReview'],
    properties: {
      summary: { type: 'array', maxItems: 3, items: claim }, concerns: claims,
      behaviors: { type: 'array', maxItems: 6, items: { type: 'object', additionalProperties: false, required: ['title', 'context', 'behavior', 'response', 'unknown'],
        properties: { title: { type: 'string', maxLength: 60 }, context: claims, behavior: claims, response: claims, unknown: { type: 'array', items: { enum: ['trigger', 'frequency', 'duration', 'response'] } } } } },
      guardianReports: claims, trainerObservations: claims, guidance: claims,
      tasks: { type: 'array', maxItems: 8, items: { type: 'object', additionalProperties: false, required: ['text', 'who', 'frequency', 'until', 'successCriteria', 'evidence'],
        properties: { text: { type: 'string', maxLength: 300 }, who: nullableText, frequency: nullableText, until: nullableText, successCriteria: nullableText, evidence: claim.properties.evidence } } },
      followUps: claims, safetyFlags: { type: 'array', items: { enum: [...NOTE_SAFETY_FLAGS] } }, methodReview: { type: 'boolean' },
    } };
  const transcript = segments.map(segment => `[${segment.id} ${formatTime(segment.startMs)} ${segment.speaker === 'guardian' ? '보호자' : '훈련사'}] ${segment.text}`).join('\n');
  return { jsonSchema, system: NOTE_INSTRUCTIONS, user: `반려동물: ${petName}\n\n전사:\n${transcript}`, maxTokens: 4096 };
}
