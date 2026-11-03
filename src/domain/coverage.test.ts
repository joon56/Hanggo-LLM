// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Caption, Speaker } from './coaching.ts';
import { consultationCoverage } from './coverage.ts';

const line = (speaker: Speaker, text: string, state: Caption['state'] = 'complete', echoSuspect = false): Caption => ({ id: text, speaker, startMs: 0, endMs: 1, text, state, echoSuspect });
const covered = (...captions: Caption[]) => consultationCoverage(captions).items.filter(item => item.covered).map(item => item.key);

describe('consultationCoverage', () => {
  it('starts with everything still open', () => {
    expect(covered()).toEqual([]);
    expect(consultationCoverage([]).safety).toEqual([]);
  });
  it.each([
    ['trigger', '택배 기사님이 초인종을 누르면 짖어요'],
    ['trigger', '혼자 있을 때 그래요'],
    ['frequency', '하루에 세 번쯤 그래요'],
    ['frequency', '일주일에 2번 정도요'],
    ['frequency', '거의 매일 그래요'],
    ['duration', '삼십 초 정도요'],
    ['duration', '한 시간 동안 그래요'],
    ['duration', '금방 멈춰요'],
    ['response', '안 돼 하고 말해요'],
    ['response', '그냥 안아서 달래요'],
    ['response', '이름을 불러요'],
  ])('hears %s from the guardian: %s', (key, text) => {
    expect(covered(line('guardian', text))).toContain(key);
  });
  it('does not count the question as the answer', () => {
    expect(covered(line('trainer', '얼마나 자주 그래요? 한 번 짖으면 얼마나 오래 짖나요? 그때 어떻게 하세요? 언제 그러나요?'))).toEqual([]);
  });
  it('does not take a connective for a situation', () => {
    expect(covered(line('guardian', '그러면 더 흥분하는 것 같아요'))).not.toContain('trigger');
  });
  it('hears a task from the trainer, not from being asked for one', () => {
    expect(covered(line('trainer', '과제는 매트로 가는 연습입니다'))).toContain('task');
    expect(covered(line('guardian', '연습은 어떻게 해요?'))).not.toContain('task');
    expect(covered(line('trainer', '요즘 어떤 상황인지 말씀해 주세요'))).not.toContain('task');
  });
  it('ignores what could not be heard or was only heard through the other microphone', () => {
    expect(covered(line('guardian', '하루에 세 번쯤 그래요', 'failed'))).toEqual([]);
    expect(covered(line('guardian', '하루에 세 번쯤 그래요', 'complete', true))).toEqual([]);
  });
  it('raises a safety signal the moment the guardian mentions one', () => {
    expect(consultationCoverage([line('guardian', '오늘 구토를 했고 다리를 절뚝거려요')]).safety).toEqual(expect.arrayContaining(['구토', '절뚝거림']));
    expect(consultationCoverage([line('trainer', '구토는 없었나요?')]).safety).toEqual([]);
  });
  it('finds everything in a consultation that covered everything', () => {
    // From fixtures/coaching-dialogues/doorbell-barking.json.
    expect(covered(
      line('guardian', '택배 기사님이 초인종을 누르면 현관으로 뛰어가서 계속 짖어요. 하루에 세 번쯤 그런 것 같아요.'),
      line('guardian', '삼십 초 정도요. 문이 닫히면 금방 멈추는데 초인종이 또 울리면 다시 짖어요.'),
      line('guardian', '안 돼 하고 큰 소리로 말해요. 그러면 더 흥분해서 짖는 것 같아요.'),
      line('trainer', '과제는 보호자님이 하루 두 번, 한 번에 삼 분씩 다음 상담까지 해 주세요.'),
    )).toEqual(['trigger', 'frequency', 'duration', 'response', 'task']);
  });
});
