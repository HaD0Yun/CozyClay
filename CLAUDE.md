# CozyClay 작업 규칙

- trunk는 `main`. 모든 작업은 `main`에서 브랜치를 따서 `main`으로 PR을 연다.
- 3.3 방향: 모션 생성 백엔드(ARDY/Kimodo)는 없다. Studio 에이전트의 기본 몸 모션 경로는 `motion` 도구다. 두 번째 모델(모션 작성자)이 장면과 모션 스펙을 쓰고, 결정적 엔진(`src/lowvis/`)이 클립을 만든다. 안내는 `src/lowvis/README.md`에 있다. 예전 결정적 모션 컴파일러(`src/motion3/`)와 QA는 MCP, `cclay live`, `COZYCLAY_MOTION_ENGINE=old`에서 쓴다. 그 설계 기록은 `docs/v3-plan.md`, 에이전트용 안내는 `docs/motion3-agent-guide.md`에 있다.
- 구현은 컨트롤 세션이 직접 한다(Codex 워커와 워크트리 규칙은 아래 2.x 절에만 해당한다).
- 아래 "CI 린트 래칫"과 "PR 기준"(테스트 통과, 250줄 래칫, knip)은 그대로 적용한다.

---

## (참고) 2.x 규칙

## 브랜치

- `main`이 유일한 trunk. `dev`는 쓰지 않는다 (main과 동일하게 유지).
- 모든 작업은 GitHub 이슈에서 시작한다. 이슈 없으면 먼저 만든다.
- 브랜치 이름: `fix/issue-<n>`, `feat/issue-<n>`, `chore/<주제>`.
- 워커는 `main`에 직접 커밋하지 않는다. 자기 브랜치에서 `main`으로 PR만 연다.
- 머지는 컨트롤 세션(사람 또는 Claude)이 순서대로 한다. 병렬은 작업에만, 통합은 직렬.
- 충돌이 나면 워커가 자기 브랜치에서 `git rebase origin/main` 한다.

## 워크트리

- 본체: `~/CozyClay` (항상 `main`, 여기서 작업하지 않는다).
- 워커: `~/CozyClay-wt/<이슈번호>`. `cozy-worker <이슈번호>` 가 워크트리 생성 + Codex 실행까지 한다.
- 동시에 최대 3개. 끝나면 `git worktree remove`.
- 같은 파일을 건드리는 이슈 두 개를 동시에 돌리지 않는다.
- vite 포트는 워크트리마다 다르게 (5180 본체, 5181~ 워커).

## 역할

- **Claude (Fable)**: 이슈 쪼개기, 워커에게 지시, PR 리뷰·검증, 머지. 오래 걸리는 구현은 하지 않는다.
- **Codex (gpt-6-astra)**: 구현, 브라우저·에디터 실사용 QA (computer use), 반복 수정 루프.
- 컨트롤 세션이 바쁘면 컨트롤이 아니다. 긴 작업은 새 세션으로 뺀다.

## PR 기준

- 한 PR = 한 이슈. 제목에 `(#n)`.
- `node tools/run-tests.mjs` 통과.
- UI 변경은 브라우저 QA 증거(스크린샷 또는 QA 스크립트 결과)를 PR 본문에 남긴다.
- 리뷰어(Claude)는 코드 diff + 테스트 + QA 증거를 보고 머지한다.

## 하지 말 것

- `.omo/`, 스크래치 파일, 실험용 npz를 커밋하지 않는다.
- 별도 클론을 만들지 않는다. 항상 워크트리.
- 커밋 메시지에 도구 서명을 넣지 않는다.

## 실행 정보 (워커용)

- 테스트 전체: `npm test` (build 포함). 목록: `npm run test:manifest`. 단일: `node test/verify-<이름>.mjs`.
- 개발 서버: `npm run dev -- --port <포트>` (본체 5180, 워커는 5180 + 이슈번호).
- 라이브 허브를 쓰는 작업이면 워커는 `COZYCLAY_LIVE_PORT=<5300+이슈번호>` 를 허브와 개발 서버 양쪽에 붙인다 (예: 이슈 329 → 5629). 기본 5184 허브를 여러 워크트리가 공유하지 않도록 한다.
- 브라우저 QA: `tools/qa-browser.mjs` (`QA_URL`, `CDP_PORT` 환경변수로 대상 지정).
- 컴퓨터 사용 QA: 에디터를 실제로 열고 클릭해서 확인. 스크린샷을 PR 본문에 첨부.
- PR 열기: `gh pr create --base main --title "<type>: <요약> (#n)"`.
- main/dev로 push·commit·checkout은 훅이 막는다. 막히면 브랜치를 확인하라.

## CI 린트 래칫

- CI는 `npm run lint`를 실행한다.
- 기준선은 `tools/*-baseline.json`에 둔다.
- PR은 미사용 export, 순수 250줄 초과 파일, 린트 오류를 늘리면 안 된다.
- 발견 사항을 의도적으로 줄이면 `npm run lint:update`를 실행한다.
- 기준선 파일은 같은 PR에 함께 커밋한다.
- PR을 통과시키려고 기준선을 올리지 않는다.

## CI 테스트 선택

- PR(`pull_request`)의 Node 샤드는 `tools/select-tests.mjs`가 고른 테스트만 돌린다: 변경 파일에 import·리터럴 읽기·리터럴 동적 import·리터럴 스폰으로 닿는 테스트, 바뀐 테스트 자신, smoke 집합(10개 이하), 경로를 변수로 조립하는 테스트.
- 아무 테스트도 닿지 않는 파일은 같은 경로 접두사의 테스트로 대신한다 (`src/motion3/` → `test/motion3/`). 그것도 비면 전체를 돌린다.
- 다음이면 전체를 돌린다: `package*.json`, `mcp/package*.json`, `vite.config.js`, `eslint.config.js`, `knip.json`, `tools/{run-tests,test-shards,select-tests,test-graph,qa-browser}.mjs`, `tools/*-baseline.json`, 워크플로, 테스트 픽스처 변경, 선택기 예외, 인벤토리 불일치, 선택이 실행 가능 집합의 50% 이상. `workflow_dispatch`는 기본이 전체이고, main의 `pages.yml`은 선택기 없이 항상 전체를 돌린다.
- 선택 결과는 `changes` 잡이 아티팩트로 한 번 올리고(전체 모드 포함), 네 샤드가 같은 목록을 나눈다. 아티팩트를 받지 못한 샤드는 전체로 대체하지 않고 실패한다(샤드끼리 목록이 달라지지 않게). 다시 실행하면 된다.
- 결과는 `changes` 잡의 step summary 표에 남는다. 로컬 확인: `git diff --name-only origin/main...HEAD | node tools/select-tests.mjs`.
