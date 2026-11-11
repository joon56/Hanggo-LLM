import { splitNoteSentences } from '../src/domain/notes.ts';

export type SentenceUnit = { id: string; text: string; start: number; end: number };
const MAX_UNIT = 2000;

// Models choose these IDs instead of rewriting evidence; code copies the exact source span.
export function numberSentences(source: string, split: (text: string) => string[] = splitNoteSentences, prefix = 'S'): SentenceUnit[] {
  const units: SentenceUnit[] = []; let cursor = 0;
  for (const sentence of split(source)) {
    const start = source.indexOf(sentence, cursor);
    if (start < 0) continue;
    cursor = start + sentence.length;
    for (let offset = 0; offset < sentence.length;) {
      let end = Math.min(sentence.length, offset + MAX_UNIT);
      if (end < sentence.length) { const space = sentence.lastIndexOf(' ', end); if (space > offset) end = space; }
      const piece = sentence.slice(offset, end).trim();
      if (piece) { const at = source.indexOf(piece, start + offset); units.push({ id: `${prefix}${units.length + 1}`, text: piece, start: at, end: at + piece.length }); }
      offset = end;
    }
  }
  return units;
}

export const unitText = (units: SentenceUnit[], id: string): string | null => units.find(unit => unit.id === id)?.text ?? null;

export function quoteRange(source: string, units: SentenceUnit[], fromId: string, toId: string): string | null {
  const from = units.findIndex(unit => unit.id === fromId), to = units.findIndex(unit => unit.id === toId);
  return from < 0 || to < from ? null : source.slice(units[from].start, units[to].end);
}
