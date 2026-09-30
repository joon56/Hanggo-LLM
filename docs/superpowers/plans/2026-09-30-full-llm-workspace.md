# 행고 A·B-1·B-2·C 구현 계획

> **For agentic workers:** Use subagent-driven-development. 사용자가 A·B-1·B-2·C 전체 구현을 명시적으로 승인했다.

**Goal:** 보호자 일상 음성·텍스트 기록, 상담 전 브리핑, 상담 음성 노트 일지, 보호소 메모 프로필을 기존 앱의 OpenAI 서버와 연결한다.

**Architecture:** React/Node 24 구조와 상담노트를 유지한다. 보호자 사건 기록은 확인 후 브라우저에 저장하고 그 자료로 서버 코드가 브리핑 수치를 계산한다. AI는 원문 근거 또는 계산된 fact ID에 연결된 결과만 반환한다. 보호소 프로필은 메모 인용과 주의사항을 보존한 뒤 직원이 확정한다.

**Tech Stack:** React, TypeScript, Express, OpenAI Responses/Audio, Zod, Vitest, Playwright.

## 제약

- 키는 서버 `.env` 또는 배포 환경에만 저장한다. 현재 키는 미설정이며 사용자가 설정하기로 했다.
- Firebase 본서비스 소스·인증·DB·실제 24개 레슨은 현재 저장소에 없다. 본서비스의 스키마나 컬렉션을 신설하지 않는다.
- 현재 앱은 단일 운영자 테스트 도구다. 역할별 화면은 계정 권한 분리가 아니다. 보호자에게 브리핑을 전달하거나 보호소 프로필을 자동 공개하지 않는다.
- 상담 음성 노트는 훈련사의 3~60초 메모다. 상담 전체 녹취·화자 분리는 범위에 넣지 않는다.
- 기능 플래그 기본 꺼짐. 명시적으로 활성화한 기능만 서버 호출 허용. 공개 Pages는 AI 호출 없는 체험만 제공한다.
- 마스킹, 정확한 인용·숫자·ID 검증, 위험 플래그 OR 보존, 검증 재시도 1회, 수동 대체, 취소와 오래된 응답 무시.
- 실제 레슨을 임의로 만들지 않는다. 검증된 카탈로그 제공 시에만 후보 필터와 레슨 연결을 사용한다.
- 원본 녹음의 서버 디스크 저장 금지. 받아쓰기 결과 확인 후에만 정리 요청. 삭제 확인 기능 유지.

## 작업 1: 보호자 기록 A

- [x] `src/domain/owner-log.ts`, `src/domain/owner-storage.ts`: 공유 타입 `workspace-types.ts` 사용. 다중 반려동물·사건·원문·시각·수정·저장 검증. `createManualOwnerDraft`, `validateOwnerDraft`, `listPets`, `savePets`, `listOwnerLogs`, `saveOwnerLog`, `deleteOwnerLog` 제공.
- [x] `server/owner-service.ts`: `OwnerInputSchema`, `OwnerExtraction`, `OWNER_INSTRUCTIONS`, `createOwnerService({model,extract}).generate(input,signal)` 제공. extract는 `(maskedInput,repair,signal)=>Promise<unknown>`.
- [x] fixtures 25건 이상과 테스트: 다중 사건·동물 불명·상대 시각·숫자·안전·무관 입력·프롬프트 주입·실패·저장 손상.
- [x] targeted Vitest 검사 후 결과 보고.

## 작업 2: 브리핑 B-1·프로필 C

- [x] `src/domain/brief.ts`: `computeBrief(input): BriefDraft`를 코드로 계산. 최근 14일과 직전 14일, 불명 시각 제외, 기록 3일 미만 표시, 존재하는 값만 사용.
- [x] `server/brief-service.ts`: `BriefInputSchema`, `BriefExtraction`, `BRIEF_INSTRUCTIONS`, `createBriefService({model,extract}).generate(input,signal)` 제공. extract는 `(factsDraft,repair,signal)=>Promise<unknown>`.
- [x] `src/domain/shelter.ts`, `src/domain/shelter-storage.ts`: `createManualShelterDraft`, `validateShelterDraft`, `listShelterProfiles`, `saveShelterProfile(draft,approvedBy,reviewed)`, `deleteShelterProfile` 제공.
- [x] `server/shelter-service.ts`: `ShelterInputSchema`, `ShelterExtraction`, `SHELTER_INSTRUCTIONS`, `createShelterService({model,extract}).generate(input,signal)` 제공. extract는 `(maskedInput,repair,signal)=>Promise<unknown>`.
- [x] B-1/C 각 10건 이상 fixture와 테스트. 없는 refs·숫자, 건강 신호, 주의사항 누락, 상반된 관찰, unknown, 실패 경로 검증.

## 작업 3: 화면과 입력 흐름

- [x] `src/components/OwnerWorkspace.tsx`, `BriefWorkspace.tsx`, `ShelterWorkspace.tsx`, 공유 음성 입력 컴포넌트. Props `{aiReady:boolean}`; API는 `src/feature-api.ts`의 `generateOwnerLog`, `generateBrief`, `generateShelterProfile` 사용.
- [x] 원문·동의·받아쓰기 확인·사건 카드 수정·검토 저장·재열람·삭제·JSON 내보내기. 반려동물 등록·선택. 브리핑은 저장된 보호자 기록으로 생성. 프로필은 직원명과 검토 후 확정·내보내기.
- [x] 각각 입력 변경/화면 종료 시 요청 취소. 늦은 응답은 버린다. AI 꺼짐/오류 시 명시적인 수동 흐름.
- [x] 기존 디자인 재사용, 모바일, 접근 가능한 라벨, 컴포넌트 회귀 검사.

## 작업 4: 서버·상담노트·평가·배포 통합

- [x] `server/config.ts`, `app.ts`, `openai.ts`, `index.ts`, `src/feature-api.ts`: 세 기능별 endpoint와 플래그·공통 인증·사용량 제한·마스킹·로그 연결. STT 프롬프트에 보호자·보호소 기록도 반영.
- [x] 실제 제공 카탈로그의 로딩·검증·후보 필터·B-2 명시적 레슨 연결. 미제공이면 커스텀 과제만 사용하고 레슨을 생성하지 않는다.
- [x] `src/App.tsx`에서 역할별 작업 메뉴 연결, 플래그·공개 체험 구분. 기존 테스트 유지.
- [x] 기능별 평가 CLI와 수동 테스트 문서, 기능별 예문·기대 조건. OpenAI 실제 키 존재 시에만 유료 실제 검증.
- [ ] 전체 `npm run verify`, 독립 코드 검토, GitHub CI, 공개 체험 배포 검증. 실제 모델·본서비스·외부 공개 여부를 구분해 보고.
