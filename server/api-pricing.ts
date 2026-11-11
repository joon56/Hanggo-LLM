// Official USD prices per million tokens, checked 2026-11-11. Gemini 3.8 Flash doubles to 1.50/7.50 from 2027-01-01.
// Haiku 5.5 uses the up-to-100K-token prompt tier; evaluation prompts stay far below it.
export const API_PRICES_CHECKED = '2026-11-11';
export const API_PRICES: Record<string, { input: number; output: number }> = {
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'claude-sonnet-5-5': { input: 2, output: 10 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5 },
};
export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = API_PRICES[model];
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
}
