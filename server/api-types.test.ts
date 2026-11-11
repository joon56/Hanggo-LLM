// @vitest-environment node
import { expect, it } from 'vitest';
import { z } from 'zod';
import { toWireSchema } from './api-types.ts';

it('converts nullable values to type arrays for Gemini and keeps anyOf for Claude', () => {
  const schema = z.object({ kind: z.enum(['a', 'b']).nullable(), note: z.string().nullable(), list: z.array(z.string()) }).strict();
  const gemini = toWireSchema(schema, 'gemini') as any, claude = toWireSchema(schema, 'claude') as any;
  expect(gemini.properties.kind).toEqual({ type: ['string', 'null'], enum: ['a', 'b', null] });
  expect(gemini.properties.note).toEqual({ type: ['string', 'null'] });
  expect(claude.properties.kind.anyOf).toHaveLength(2);
  expect(gemini).not.toHaveProperty('$schema'); expect(claude).not.toHaveProperty('$schema');
  expect(gemini).toMatchObject({ type: 'object', additionalProperties: false, required: ['kind', 'note', 'list'] });
});
