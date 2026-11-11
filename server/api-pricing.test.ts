// @vitest-environment node
import { expect, it } from 'vitest';
import { API_PRICES_CHECKED, estimateCostUsd } from './api-pricing.ts';

it('estimates cost from per-million-token prices and refuses unknown models', () => {
  expect(API_PRICES_CHECKED).toBe('2026-11-11');
  expect(estimateCostUsd('claude-haiku-5-5', 1_000_000, 1_000_000)).toBeCloseTo(0.6);
  expect(estimateCostUsd('gemini-3.8-flash', 2_000_000, 0)).toBeCloseTo(1.5);
  expect(estimateCostUsd('gpt-6', 1, 1)).toBeNull();
});
