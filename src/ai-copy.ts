export type AiProvider = 'ollama' | 'api';
// Saved drafts keep the model that produced them, so labels follow the draft rather than the current setting.
export const isExternalModel = (model?: string) => /^(gemini|claude)-/.test(model ?? '');
export const processingPhrase = (provider?: AiProvider) => provider === 'api' ? '외부 AI(Google·Anthropic)로 전송해 처리' : '이 PC의 로컬 AI 서버에서 처리';
export const aiDraftLabel = (model?: string) => isExternalModel(model) ? '외부 AI 초안' : '로컬 AI 초안';
