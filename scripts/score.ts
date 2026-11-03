import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadLocalEnv, readConfig } from '../server/config.ts';

// Usage: node scripts/score.ts [label]
// Adds one dated block to docs/llm/scoreboard.md from the latest measurement reports on this PC.
// Each row says what it was measured on, so synthetic results never read as real use.
const BOARD = path.resolve('docs/llm/scoreboard.md');
const HEADER = `# 점수판

측정할 때마다 아래에 한 묶음씩 쌓는다. 조건 칸을 함께 본다. 합성 입력 결과를 실제 사용 결과로 읽지 않는다.
다음 개선은 가장 낮은 값을 골라 재현 시험부터 만든다. 설계 §19 참고.
`;
type Row = [area: string, metric: string, value: string, condition: string];
const readJson = (file: string) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
const percent = (value: number | null | undefined) => value === null || value === undefined ? '해당 없음' : `${(value * 100).toFixed(1)}%`;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const maxOf = (values: number[]) => values.length ? Math.max(...values) : null;

function callRows(): Row[] {
  const report = readJson('.tmp/call-metrics.json');
  if (!report) return [];
  const { direct, relay } = report;
  return [
    ['통화', '연결 성공', `직접 ${direct.connected}/${direct.attempts}, 중계 ${relay.connected}/${relay.attempts}`, '이 PC의 Chrome 2개, 합성 영상. 실제 네트워크 아님'],
    ['통화', '연결 시간 중앙값', `직접 ${direct.connectMedianMs}ms, 중계 ${relay.connectMedianMs}ms`, '중계는 실제 TURN 서버 경유'],
    ['통화', '끊김 후 복구 중앙값', `${direct.recoverMedianMs}ms`, '3초 오프라인 후. 같은 PC라 실제 망 전환보다 유리함'],
  ];
}

function speechRows(file: string, condition: string): Row[] {
  const report = readJson(file);
  if (!report?.results?.length) return [];
  const results = report.results as { cer: Record<string, number>; speakerLabels: { judged: number; mislabeled: number }; captionDelayMs: { trainerScreen: { p95?: number } }; uploadsBeforeConsent: number; terms?: { found: number; total: number }; catch?: { earliestBeforeMs: number } }[];
  const terms = results.flatMap(item => item.terms ? [item.terms] : []);
  const found = terms.reduce((sum, item) => sum + item.found, 0); const total = terms.reduce((sum, item) => sum + item.total, 0);
  return [
    ['전사', '문자 오류율 평균', percent(mean(results.flatMap(item => Object.values(item.cer)))), condition],
    ['전사', '행동 용어 재현율', total ? `${found}/${total} (${percent(found / total)})` : '미측정', condition],
    ['전사', '화자 오류', `${results.reduce((sum, item) => sum + item.speakerLabels.mislabeled, 0)}/${results.reduce((sum, item) => sum + item.speakerLabels.judged, 0)}`, condition],
    ['전사', '자막 지연 p95 최댓값', `${maxOf(results.flatMap(item => item.captionDelayMs.trainerScreen.p95 ?? []))}ms`, `${condition}. 구간 끝부터 화면까지`],
    ['전사', '동의 전 업로드', `${results.reduce((sum, item) => sum + item.uploadsBeforeConsent, 0)}건`, condition],
    ['장면', '캐치 사진의 가장 이른 시점', `버튼 ${((mean(results.flatMap(item => item.catch?.earliestBeforeMs ?? [])) ?? 0) / 1000).toFixed(1)}초 전`, condition],
  ];
}

function noteRows(home: string): Row[] {
  const folder = path.join(home, 'cache', 'eval');
  if (!existsSync(folder)) return [];
  return readdirSync(folder).filter(name => /^note-eval-[^.]+\.json$/.test(name) && !/-(?:first|second)\.json$/.test(name)).flatMap((name): Row[] => {
    const report = readJson(path.join(folder, name));
    const { summary, model } = report;
    const condition = `${model}, 합성 대화 ${summary.dialogues}건, 전사 오류 없음`;
    if (name.endsWith('-long.json')) {
      const [run] = report.runs;
      return [['일지', '30분 이상 상담 처리 시간', `${Math.round(run.latencyMs / 60000)}분`, `${model}, 합성 대화를 이어 붙임`], ['일지', '긴 상담 사실 재현율', percent(summary.factRecall), `${model}, 합성 대화를 이어 붙임`]];
    }
    return [
      ['일지', '핵심 사실 재현율', percent(summary.factRecall), condition],
      ['일지', '근거 없는 숫자', `${summary.unsupportedNumbers}건`, condition],
      ['일지', '금지·허위 주장', `${summary.forbiddenHits}건`, condition],
      ['일지', '과제 재현율', percent(summary.taskRecall), condition],
      ['일지', '꾸며낸 과제', `${summary.inventedTasks}건`, condition],
      ['일지', '과제 항목(담당·횟수·기한·미확인) 정확도', percent(summary.taskFieldRecall), condition],
      ['일지', '말한 사람 구분', percent(summary.attributionRecall), condition],
      ['일지', '안전 신호 재현율', `${percent(summary.safetyRecall)}, 오탐 ${summary.extraSafetyFlags}건`, condition],
      ['일지', '체벌 표시 불일치', `${summary.methodReviewMismatch}건`, condition],
    ];
  });
}

loadLocalEnv();
const home = readConfig().home;
const label = process.argv[2] ?? '';
const rows: Row[] = [
  ...callRows(),
  ...speechRows('.tmp/real-speech/report.json', 'Qwen3-ASR, 합성 음성(Heami), 가짜 마이크'),
  ...speechRows('.tmp/real-speech/report-human.json', 'Qwen3-ASR, 실제 사람의 낭독(zeroth_korean), 상담 대화 아님, 가짜 마이크'),
  ...noteRows(home),
];
const now = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ');
const block = `\n## ${now} KST${label ? ` · ${label}` : ''}\n\n| 영역 | 지표 | 값 | 조건 |\n|---|---|---|---|\n${rows.map(row => `| ${row.join(' | ')} |`).join('\n')}\n\n사람 시연 결과, 훈련사 수정 없이 확정한 비율: 아직 없음.\n`;
writeFileSync(BOARD, (existsSync(BOARD) ? readFileSync(BOARD, 'utf8') : HEADER) + block);
console.info(`${rows.length} rows added to ${BOARD}`);
