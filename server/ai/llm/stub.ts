import type { LlmProvider } from './types.ts';

const LINE = /^\[(s\d+) \d+:\d+ (보호자|훈련사)\] (.+)$/gm;
const STATEMENT = /^\[(s\d+)[^\]]*\] (.+)$/gm;
const MAX_ITEMS = 3;

/**
 * For automated runs only. It copies transcript lines into the note's sections, so a run can prove the
 * whole path from speech to delivery without a GPU. It judges nothing, and its results say nothing about quality.
 */
export function createStubLlm(): LlmProvider {
  return {
    name: 'stub', supportsVision: true,
    async release() {},
    async structured({ images, user }) {
      if (images?.length) return { finished: true, json: { observations: [`[시험 관찰] 사진 ${images.length}장을 받았습니다.`] } };
      if (user.includes('문장 목록')) {
        const statements = [...user.matchAll(STATEMENT)].slice(0, MAX_ITEMS);
        return { finished: true, json: { summary: statements.map(([, alias, text]) => ({ text, evidence: [alias] })) } };
      }
      const lines = [...user.matchAll(LINE)].map(([, alias, speaker, text]) => ({ alias, speaker, text }));
      const claim = ({ alias, text }: { alias: string; text: string }) => ({ text, evidence: [alias] });
      const guardian = lines.filter(line => line.speaker === '보호자').slice(0, MAX_ITEMS);
      const trainer = lines.filter(line => line.speaker === '훈련사').slice(0, MAX_ITEMS);
      return { finished: true, json: {
        summary: lines.slice(0, 1).map(claim), concerns: [], behaviors: [], guardianReports: guardian.map(claim), trainerObservations: [], guidance: trainer.map(claim),
        tasks: trainer.slice(0, 1).map(line => ({ text: line.text, who: null, frequency: null, until: null, successCriteria: null, evidence: [line.alias] })),
        followUps: [], safetyFlags: [], methodReview: false,
      } };
    },
  };
}
