import { readFileSync, statSync } from 'node:fs';
import { LessonCatalogSchema, type Lesson } from '../src/domain/lessons.ts';

export function loadLessonCatalog(path?: string): Lesson[] {
  if (!path?.trim()) return [];
  try {
    if (statSync(path).size > 2_000_000) throw new Error('size');
    return LessonCatalogSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch { throw new Error('레슨 카탈로그를 읽거나 검증할 수 없습니다. 파일 형식과 ID, 선행 레슨을 확인하세요.'); }
}
