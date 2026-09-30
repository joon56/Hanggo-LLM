import { downloadJson } from './workspace-utils';

type Props = { feature: string; input: unknown; output: unknown; requestId?: string; error?: string };

export default function IssueReport({ feature, input, output, requestId, error }: Props) {
  return <button className="ws-link ws-report" type="button" onClick={() => downloadJson(`hanggo-${feature}-issue-${Date.now()}.json`, { feature, input, output, requestId: requestId ?? null, error: error ?? null, exportedAt: new Date().toISOString() })}>이상해요 · 오류 보고서 다운로드</button>;
}
