import { describe, expect, it } from 'vitest';
import { can, type Action, type Actor } from './permissions';

const trainer: Actor = { role: 'trainer' };
const guardian: Actor = { role: 'guardian', caseId: 'case-1' };
const other = 'case-2';

// Mirrors the permission table in docs/superpowers/specs/2026-11-03-two-way-coaching-design.md section 7.
const table: [Action, 'trainer-only' | 'shared' | 'guardian-writes'][] = [
  ['case:create', 'trainer-only'],
  ['case:invite', 'trainer-only'],
  ['case:delete', 'trainer-only'],
  ['consultation:start', 'trainer-only'],
  ['consultation:end', 'trainer-only'],
  ['brief:read', 'trainer-only'],
  ['transcript:edit', 'trainer-only'],
  ['scene:review', 'trainer-only'],
  ['note:draft', 'trainer-only'],
  ['frame:read-all', 'trainer-only'],
  ['method-review:read', 'trainer-only'],
  ['case:read', 'shared'],
  ['call:join', 'shared'],
  ['consent:set', 'shared'],
  ['caption:read', 'shared'],
  ['moment:create', 'shared'],
  ['delivery:read', 'shared'],
  ['recording:upload', 'shared'],
  ['frame:read-cited', 'shared'],
  ['task-log:read', 'shared'],
  ['task-log:write', 'guardian-writes'],
  ['guardian-log:write', 'guardian-writes'],
  ['guardian-log:read', 'shared'],
];

describe('can', () => {
  it.each(table)('%s is %s', (action, rule) => {
    expect(can(trainer, action, 'case-1')).toBe(rule !== 'guardian-writes');
    expect(can(guardian, action, 'case-1')).toBe(rule !== 'trainer-only');
    expect(can(guardian, action, other)).toBe(false);
    expect(can(guardian, action)).toBe(false);
  });
  it('covers every action in the table', () => {
    expect(table.length).toBe(23);
  });
  it('denies unknown actions by default', () => {
    expect(can(trainer, 'admin:everything' as Action, 'case-1')).toBe(false);
  });
});
