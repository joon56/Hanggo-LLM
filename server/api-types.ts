import { z } from 'zod';

export type ApiVendor = 'gemini' | 'claude';
export type ApiUsage = { model: string; inputTokens: number; outputTokens: number; latencyMs: number };
export type StructuredRequest = { model: string; system: string; input: unknown; schema: z.ZodType; signal?: AbortSignal };
export type StructuredResult = { json: unknown; inputTokens: number; outputTokens: number };
export type StructuredClient = (request: StructuredRequest) => Promise<StructuredResult>;

// Claude accepts anyOf; Gemini documents nullable values as type arrays.
export function toWireSchema(schema: z.ZodType, vendor: ApiVendor): Record<string, unknown> {
  const normalize = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(normalize);
    if (!node || typeof node !== 'object') return node;
    const object = Object.fromEntries(Object.entries(node).filter(([key]) => key !== '$schema').map(([key, value]) => [key, normalize(value)])) as Record<string, unknown>;
    const options = object.anyOf;
    if (vendor !== 'gemini' || !Array.isArray(options) || options.length !== 2) return object;
    const other = options.find(option => (option as { type?: unknown }).type !== 'null') as Record<string, unknown> | undefined;
    if (!other || typeof other.type !== 'string' || !options.some(option => (option as { type?: unknown }).type === 'null')) return object;
    const { anyOf: _anyOf, ...rest } = object;
    return { ...rest, ...other, type: [other.type, 'null'], ...(Array.isArray(other.enum) ? { enum: [...other.enum, null] } : {}) };
  };
  return normalize(z.toJSONSchema(schema)) as Record<string, unknown>;
}
