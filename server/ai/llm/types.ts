export type LlmRequest = { jsonSchema: object; system: string; user: string; images?: Buffer[]; maxTokens?: number; signal?: AbortSignal };
/** `json` is null when output is not valid JSON. `finished` is false when generation stopped early. */
export type LlmOutput = { json: unknown; finished: boolean };
export type LlmProvider = {
  name: string;
  supportsVision: boolean;
  structured(request: LlmRequest): Promise<LlmOutput>;
  release(): Promise<void>;
};
