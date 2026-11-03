import type { Caption, Speaker } from './coaching.ts';
import { flagsFromSource } from './notes.ts';

export type CoverageKey = 'trigger' | 'frequency' | 'duration' | 'response' | 'task';

/**
 * What a behavior note needs from the conversation, read from what was actually said rather than asked.
 * These only remind the trainer during the call and decide nothing, so a wrong guess costs little and no model is needed.
 */
const CHECKS: { key: CoverageKey; label: string; speaker: Speaker; pattern: RegExp }[] = [
  { key: 'trigger', label: '언제', speaker: 'guardian', pattern: /(?<!그러|그렇|아니|그리)면\s|[가-힣]\s?때(?:마다|는|면|도)?(?:\s|$)/ },
  { key: 'frequency', label: '빈도', speaker: 'guardian', pattern: /하루에?\s|일주일에?\s|매일|날마다|자주|가끔|종종|[0-9]+\s?(?:번|회)|(?:두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s?(?:번|차례)/ },
  { key: 'duration', label: '지속 시간', speaker: 'guardian', pattern: /(?:[0-9]+|[일이삼사오육칠팔구십백]+|한|두|세|네|다섯|여섯|몇)\s?(?:초|분|시간)|오래|금방|잠깐|한참|동안/ },
  { key: 'response', label: '보호자 대응', speaker: 'guardian', pattern: /안\s?돼|하지\s?마|그만|달래|안아|불러|혼내|혼냈|무시|쓰다듬|말려|말리|막아|잡아|당겨|당기|데려|간식을?\s(?:줘|주)/ },
  { key: 'task', label: '과제', speaker: 'trainer', pattern: /과제|숙제|연습|다음 상담까지/ },
];

/** Live prompts for the trainer. Lines heard through the other person's microphone say nothing about who said them, so they do not count. */
export function consultationCoverage(captions: Caption[]) {
  const heard = captions.filter(item => item.state === 'complete' && !item.echoSuspect);
  const said = (speaker: Speaker) => heard.filter(item => item.speaker === speaker).map(item => item.text);
  return {
    items: CHECKS.map(({ key, label, speaker, pattern }) => ({ key, label, covered: said(speaker).some(text => pattern.test(text)) })),
    safety: flagsFromSource(said('guardian').join('\n')),
  };
}
