export type Category = 'owner_report' | 'observation' | 'guidance' | 'task' | 'follow_up';
export type SourceKind = 'trainer_summary_text' | 'trainer_summary_voice';
export type Metadata = { petName: string; trainerName: string; sessionDate: string };
export type NoteItem = { id: string; category: Category; text: string; sourceQuote: string; edited: boolean };
export type NoteMode = 'demo' | 'openai' | 'ollama' | 'manual';
export type Generation = { requestId: string; model: string; promptVersion: string; latencyMs: number; fallbackUsed: boolean };
export type Draft = { id: string; sourceKind: SourceKind; sourceText: string; items: NoteItem[]; safetyFlags: string[]; methodReview: boolean; createdAt: string; mode: NoteMode; generation?: Generation };
export type ApprovedNote = { id: string; metadata: Metadata; draft: Draft; approvedAt: string; mode: NoteMode };

const categories: Category[] = ['owner_report', 'observation', 'guidance', 'task', 'follow_up'];
const sourceKinds: SourceKind[] = ['trainer_summary_text', 'trainer_summary_voice'];
const safetyPatterns: [string, RegExp][] = [
  ['통증', /통증|아프|아파|아픈|pain/i],
  ['구토', /구토|토했|토함|토해|vomit/i],
  ['출혈', /출혈|피가\s*나|bleed/i],
  ['절뚝거림', /절뚝|다리를\s*절|limp/i],
  ['갑작스러운 공격성', /갑자기\s*(?:공격|물었|물려)|갑작스러운\s*공격|sudden aggression/i],
  ['호흡 곤란', /호흡\s*곤란|숨(?:을)?\s*(?:못\s*쉬|가쁘)|breath(?:ing)?\s*(?:difficulty|problem)/i],
  ['발작', /발작|경련|seizure/i],
  ['설사', /설사|diarrh(?:ea|ea)/i],
  ['식욕 저하', /안\s*먹|먹지\s*않|식욕\s*(?:저하|없)|not\s*eat/i],
  ['물림', /물렸|물었|물린|깨물|bite|bitten/i],
];
const methodPattern = /강압|체벌|때리|혼내|목줄을?\s*(?:강하게|세게|확)\s*당(?:기|겨)|억지로|coercive|aversive/i;
const bannedClaim = /확진|진단(?:입니다|이다|됨|됐)|반드시\s*(?:낫|완치)|100\s*%\s*(?:치료|완치|해결)|완치됩니다/i;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const newId = () => crypto.randomUUID();

function flagsFromSource(source: string): string[] {
  return safetyPatterns.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
}

export function getReviewSignals(draft: Draft): { safetyFlags: string[]; methodReview: boolean } {
  const text = [draft.sourceText, ...draft.items.map(item => item.text)].join('\n');
  return {
    safetyFlags: [...new Set([...draft.safetyFlags, ...flagsFromSource(text)])],
    methodReview: draft.methodReview || methodPattern.test(text),
  };
}

export function splitNoteSentences(source: string): string[] {
  const result: string[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    const decimalPoint = char === '.' && /\d/.test(source[index - 1] ?? '') && /\d/.test(source[index + 1] ?? '');
    if (char === '\n' || (/[.!?。！？]/.test(char) && !decimalPoint)) {
      const quote = source.slice(start, char === '\n' ? index : index + 1).trim();
      if (quote) result.push(quote);
      start = index + 1;
    }
  }
  const tail = source.slice(start).trim();
  if (tail) result.push(tail);
  return result;
}

function classify(sentence: string): Category {
  if (flagsFromSource(sentence).length || methodPattern.test(sentence) || bannedClaim.test(sentence)) return 'follow_up';
  if (/보호자(?:가|는|께서)?|견주(?:가|는)?|말씀하|전했|보고했/i.test(sentence)) return 'owner_report';
  if (/다음\s*(?:시간|수업)|추후|확인(?:하|해)|지켜보|follow.?up/i.test(sentence)) return 'follow_up';
  if (/과제|숙제/i.test(sentence)) {
    if (/아직|정하지\s*않|하지\s*않|안\s*하|하지\s*말|보류|미정/i.test(sentence)) return 'follow_up';
    return /기로\s*했|기로\s*정했|과제로\s*정했|과제로\s*했|과제(?:는|로)?[^.!?]*연습하세요|숙제(?:는|로)?[^.!?]*연습하세요/i.test(sentence) ? 'task' : 'follow_up';
  }
  if (/매일/i.test(sentence)) return 'follow_up';
  if (/권장|안내|제안|추천|해주세요|하십시오|하세요/i.test(sentence)) return 'guidance';
  if (/관찰|보였|했습니다|했어요|나타났|수행했|연습했습니다/i.test(sentence)) return 'observation';
  return 'follow_up';
}

export function createDraft(text: string, sourceKind: SourceKind): Draft {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw new Error('원문은 1~8000자로 입력하세요.');
  if (!sourceKinds.includes(sourceKind)) throw new Error('지원하지 않는 원문 종류입니다.');
  const safetyFlags = flagsFromSource(text);
  const methodReview = methodPattern.test(text);
  return {
    id: newId(), sourceKind, sourceText: text,
    items: splitNoteSentences(text).map(sourceQuote => {
      const category = classify(sourceQuote);
      return { id: newId(), category: (safetyFlags.length || methodReview) && category === 'task' ? 'follow_up' : category, text: sourceQuote, sourceQuote, edited: false };
    }),
    safetyFlags, methodReview,
    createdAt: new Date().toISOString(), mode: 'demo',
  };
}

export function createManualDraft(text: string, sourceKind: SourceKind): Draft {
  const base = createDraft(text, sourceKind);
  const items: NoteItem[] = [];
  for (let index = 0; index < text.length; index += 2000) {
    const quote = text.slice(index, index + 2000).trim();
    if (quote) items.push({ id: newId(), category: 'follow_up', text: quote, sourceQuote: quote, edited: false });
  }
  return { ...base, mode: 'manual', items };
}

export function validateDraft(draft: Draft): string[] {
  const errors: string[] = [];
  if (!isObject(draft)) return ['초안 형식이 올바르지 않습니다.'];
  if (!['demo', 'openai', 'ollama', 'manual'].includes(draft.mode) || typeof draft.id !== 'string' || !draft.id.trim() ||
    !sourceKinds.includes(draft.sourceKind) || typeof draft.sourceText !== 'string' ||
    !draft.sourceText.trim() || draft.sourceText.length > 8000 ||
    typeof draft.createdAt !== 'string' || !Number.isFinite(Date.parse(draft.createdAt))) {
    errors.push('초안 기본 정보가 올바르지 않습니다.');
  }
  if (!Array.isArray(draft.items) || draft.items.length === 0) return [...errors, '원문에서 추출한 항목이 필요합니다.'];
  if (draft.items.length > 100) errors.push('초안 항목은 최대 100개입니다.');
  if (draft.generation !== undefined) {
    const g = draft.generation;
    if (!isObject(g) || typeof g.requestId !== 'string' || typeof g.model !== 'string' ||
      typeof g.promptVersion !== 'string' || !Number.isFinite(g.latencyMs) || g.latencyMs < 0 ||
      typeof g.fallbackUsed !== 'boolean') errors.push('생성 정보가 올바르지 않습니다.');
  }
  if (!Array.isArray(draft.safetyFlags) || !draft.safetyFlags.every(flag => typeof flag === 'string') ||
    typeof draft.methodReview !== 'boolean') errors.push('안전 검토 정보가 올바르지 않습니다.');
  const source = typeof draft.sourceText === 'string' ? draft.sourceText : '';
  const expectedFlags = flagsFromSource(source);
  if (!Array.isArray(draft.safetyFlags) || expectedFlags.some(flag => !draft.safetyFlags.includes(flag))) errors.push('원문 안전 신호를 삭제할 수 없습니다.');
  if (methodPattern.test(source) && draft.methodReview !== true) errors.push('원문 훈련 방법 검토 표시를 삭제할 수 없습니다.');
  const effectiveRisk = Array.isArray(draft.safetyFlags) && draft.safetyFlags.every(flag => typeof flag === 'string') &&
    draft.items.every(item => isObject(item) && typeof item.text === 'string') ? getReviewSignals(draft) : null;
  const ids = new Set<string>();
  for (const item of draft.items) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id) ||
      !categories.includes(item.category) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000 ||
      typeof item.sourceQuote !== 'string' || !item.sourceQuote.trim() || !source.includes(item.sourceQuote) ||
      typeof item.edited !== 'boolean') {
      errors.push('항목 형식 또는 원문 근거가 올바르지 않습니다.');
      continue;
    }
    ids.add(item.id);
    if (!item.edited && item.text !== item.sourceQuote) errors.push('수정되지 않은 항목은 원문 인용과 같아야 합니다.');
    if ((effectiveRisk?.safetyFlags.length || effectiveRisk?.methodReview) && item.category === 'task')
      errors.push('안전 검토가 필요한 문장은 과제로 분류할 수 없습니다.');
    if (item.category === 'task' && classify(item.sourceQuote) !== 'task')
      errors.push('명확히 합의된 과제만 과제로 분류할 수 있습니다.');
    if (bannedClaim.test(item.sourceQuote) && item.category !== 'follow_up')
      errors.push('원문의 진단 또는 결과 보장 표현은 후속 확인으로 분류해야 합니다.');
    if (bannedClaim.test(item.text) && item.text !== item.sourceQuote)
      errors.push('진단 또는 결과 보장 표현은 추가할 수 없습니다.');
    const quoteNumbers = new Set(item.sourceQuote.match(/\d+(?:[.,]\d+)*/g) ?? []);
    if ((item.text.match(/\d+(?:[.,]\d+)*/g) ?? []).some(number => !quoteNumbers.has(number)))
      errors.push('원문에 없는 숫자를 추가할 수 없습니다.');
  }
  return errors;
}

function validDate(date: unknown): boolean {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date);
}

export function approveDraft(draft: Draft, metadata: Metadata, reviewed: boolean): ApprovedNote {
  if (reviewed !== true) throw new Error('검토 확인 후 승인할 수 있습니다.');
  if (!isObject(metadata) || typeof metadata.petName !== 'string' || !metadata.petName.trim() ||
    typeof metadata.trainerName !== 'string' || !metadata.trainerName.trim() || !validDate(metadata.sessionDate))
    throw new Error('반려견 이름, 훈련사 이름, 수업 날짜를 확인하세요.');
  const errors = validateDraft(draft);
  if (errors.length) throw new Error(errors.join(' '));
  return {
    id: newId(), metadata: { petName: metadata.petName.trim(), trainerName: metadata.trainerName.trim(), sessionDate: metadata.sessionDate },
    draft: { ...structuredClone(draft), ...getReviewSignals(draft) }, approvedAt: new Date().toISOString(), mode: draft.mode,
  };
}
