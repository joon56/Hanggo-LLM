import { expect, it } from 'vitest';
import { aiDraftLabel, isExternalModel, processingPhrase } from './ai-copy';

it('describes where text is processed and labels drafts by the model that made them', () => {
  expect(processingPhrase()).toBe('이 PC의 로컬 AI 서버에서 처리');
  expect(processingPhrase('api')).toBe('외부 AI(Google·Anthropic)로 전송해 처리');
  expect(isExternalModel('gemini-3.8-flash')).toBe(true); expect(isExternalModel('claude-haiku-5-5')).toBe(true); expect(isExternalModel('qwen3.5:9b')).toBe(false);
  expect(aiDraftLabel('claude-sonnet-5-5')).toBe('외부 AI 초안'); expect(aiDraftLabel(undefined)).toBe('로컬 AI 초안');
});
