export type Actor = { role: 'trainer' } | { role: 'guardian'; caseId: string };

const trainerOnly = ['case:create', 'case:invite', 'consultation:start', 'consultation:end', 'brief:read', 'transcript:edit', 'scene:review', 'note:draft', 'frame:read-all', 'method-review:read'] as const;
const shared = ['case:read', 'call:join', 'consent:set', 'caption:read', 'moment:create', 'delivery:read', 'frame:read-cited', 'task-log:read'] as const;
const guardianWrites = ['task-log:write'] as const;
export type Action = typeof trainerOnly[number] | typeof shared[number] | typeof guardianWrites[number];

const includes = (list: readonly Action[], action: Action) => list.includes(action);

/** Unknown actions are denied. A guardian only ever acts on the one case their session belongs to. */
export function can(actor: Actor, action: Action, caseId?: string): boolean {
  if (actor.role === 'trainer') return includes(trainerOnly, action) || includes(shared, action);
  if (!caseId || actor.caseId !== caseId) return false;
  return includes(shared, action) || includes(guardianWrites, action);
}
