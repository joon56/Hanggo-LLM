# 상담 후 요약 데모 구현 계획

## 목표와 구조

승인된 `summary-demo-design.md` 흐름의 독립 로컬 데모를 구현한다. React·TypeScript·Vite. 공급사 미선택이므로 네트워크 AI 호출 없이 녹음·입력·추출·검토·승인을 연결한다.

## 공통 제약

- 기존 가이드와 step0_report.md 수정 금지.
- 비밀값 없음. 외부 AI 호출·새 Firebase 컬렉션·실제 레슨 데이터 생성 없음.
- 데모 분류와 실제 받아쓰기를 혼동시키지 않는다.
- 원문 인용 유지. 사용자가 수정한 내용은 별도 표시.
- 앱은 localhost에서 실행. 승인된 기록만 브라우저 저장. 음성은 메모리만 사용.

## 작업 1: 원문·초안·저장 규칙

- [x] `src/domain/notes.ts`, `src/domain/storage.ts`, 관련 테스트 생성.
- [x] 분류·근거·안전·승인·저장 실패를 테스트로 먼저 정의하고 실패 확인.
- [x] 원문을 바꾸지 않는 데모 분류와 승인 기록 저장 구현.
- [x] 테스트 통과 및 코드 검토.

공통 인터페이스:

```ts
type Category = 'owner_report' | 'observation' | 'guidance' | 'task' | 'follow_up';
type SourceKind = 'trainer_summary_text' | 'trainer_summary_voice';
type Metadata = { petName: string; trainerName: string; sessionDate: string };
type NoteItem = { id: string; category: Category; text: string; sourceQuote: string; edited: boolean };
type Draft = { id: string; sourceKind: SourceKind; sourceText: string; items: NoteItem[]; safetyFlags: string[]; methodReview: boolean; createdAt: string; mode: 'demo' };
type ApprovedNote = { id: string; metadata: Metadata; draft: Draft; approvedAt: string; mode: 'demo' };
function createDraft(text: string, sourceKind: SourceKind): Draft;
function validateDraft(draft: Draft): string[];
function approveDraft(draft: Draft, metadata: Metadata, reviewed: boolean): ApprovedNote;
function listNotes(storage?: Storage): ApprovedNote[];
function saveNote(note: ApprovedNote, storage?: Storage): void;
function deleteNote(id: string, storage?: Storage): void;
```

## 작업 2: 녹음·편집·승인 화면

- [x] 녹음 상태·마이크 정리·원문 변경 무효화·저장 버튼 차단을 테스트로 먼저 확인.
- [x] `src/hooks/useRecorder.ts`와 테스트 작성. MIME 지원 검사·60초 제한·정지·취소·재생 URL 정리.
- [x] `src/App.tsx`, `src/components/`, `src/styles.css`에 반응형 UI 작성.
- [x] 명시적인 예시 로딩, 안전 안내, 원문 강조, 항목 편집, 승인·재열람·JSON 다운로드·삭제 연결.

## 작업 3: 검증·실행 안내

- [x] `npm.cmd test`, `npm.cmd run build` 통과.
- [x] 브라우저에서 예시·수정·승인·재열람·삭제 및 모바일 폭 확인.
- [x] 독립 코드 검토 후 중요한 문제 수정.
- [x] README에 실행 명령, 실제 녹음과 데모 분류의 차이, 저장 위치, 테스트 제한, 향후 서버 연결 경계 기록.
- [x] 개발 서버를 로컬에 실행하고 접속 주소 안내.

Git 저장소가 아니므로 커밋·브랜치·worktree 작업은 수행하지 않는다. 사용자가 구현을 승인했으므로 추가 실행 승인 없이 진행한다.
