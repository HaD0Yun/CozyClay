# CozyClay Studio UI 정보구조(IA) — 남길 것, 접을 것, 지울 것
STATUS: 구현 완료 — IA PR 6개(#196 #198 #197 #200 #201 #204) + 꼬리 #205 + 테스트 후속 #202 머지. 최종 실측은 §1 표(df1640d). 리서치 세션 `.omo/ulw-research/20260909-224600-studio-ui-simplify/` (보고서 PDF 포함).

> 이 문서는 Studio(`/app/`) UI 단순화의 결정 기록이다. 컨트롤 하나마다 **유지 / 이동 / 접기 / 삭제**를 정하고, 근거와 새 위치와 영향받는 테스트를 적는다. 구현 PR은 §7의 순서로 연다.

## 1. 왜 지금인가 (실측)

2026-09-09, 1600×1000, 캐릭터 1 + 432프레임 모션, 샷 없음 기준 동시 노출 컨트롤 수 (`tools/qa/studio-control-count.mjs`, 렌더된 DOM에서 박스가 있는 button/select/range/checkbox):

| 상태 | 시작 (385d340) | 목표 (R6) | 6개 PR 후 (e384d00) | 꼬리 PR 후 |
|---|---|---|---|---|
| Scene | 49 | ≤35 | 38 | **35** |
| Camera | 54 (샷 선택 시 59) | ≤38 | 41 | **38** |
| Motion | 65 (캐릭터 선택 시 68) | ≤52 | 55 | **51** |

e384d00에서 남은 초과분은 세 모드 모두 같은 세 컨트롤이었다: 씬 루트 행의 접기 캐럿, `Characters` 그룹 행과 그 캐럿, 블록이 0개일 때도 렌더되는 `Generate all 0 blocks`(R3 위반). 꼬리 PR #205가 이 셋을 처리해 df1640d에서 R6 예산을 전부 충족한다(같은 스크립트·같은 시나리오, `tools/qa/studio-control-count.mjs`). 추정치(32/37/44)와 실측이 어긋난 이유: 트리 캐럿은 3개가 아니라 4개였고 씬 선택 필이 새 버튼으로 잡히며(계층 16→14, 12가 아님), QA 프로젝트는 로드된 Full-Body 세그먼트를 자동 선택해 Motion 모드에 세그먼트 도구 6개가 렌더된다.

### v2 기준선 (40767ed, #533)

오너의 v2 디자인(`docs/design/v2-reference.html`)이 R6를 대체했다: 항상 보이는 Content 브라우저와 버튼으로 렌더되는 Outliner 행을 더하므로, 옛 지표(보이는 컨트롤 전부)는 더 이상 같은 것을 재지 않는다. 그래서 `tools/qa/studio-control-count.mjs`는 이제 **controls**(크롬)와 **items**(데이터: Outliner 트리 행과 그 펼침 캐럿, Content 에셋 타일, Content 카테고리 행)를 나눠 세고, 예산은 controls에만 건다(40767ed에서 잰 값 그대로, 여유 없음; 넘으면 exit 1). 같은 시나리오(1600×1000, 캐릭터 1 + `walk-then-stop` 432프레임, 샷 없음):

| 상태 | 옛 R6 목표 | 옛 지표 합계 | v2 controls (= 예산) | v2 items |
|---|---|---|---|---|
| Stage, 선택 없음 | ≤35 | 59 | **37** | 22 |
| Stage, 캐릭터 선택 | ≤35 | 67 | **45** | 22 |
| Pose (2, IK 켜짐) | ≤45 | 90 | **58** | 32 |
| Camera | ≤38 | 71 | **39** | 32 |
| Motion (캐릭터 선택) | ≤52 | 87 | **52** (#550; 40767ed에서 55) | 32 |

Pose Details 패널만 세면 13개다(#545의 `qa-shell-pose-browser` 지표, ≤45). 계측 JSON에는 영역별 내역(`by.controls`, `by.items`)이 함께 남는다.

마지막으로 수치를 잰 정리는 `bf76a89`(08-27, 65/64/66/76 → 62/52/44/63)였고, 그 뒤 12일 동안 Export 메뉴·Part colours·Target model·Workflow 링크 등이 얹히며 다시 늘었다.

핵심 원인 4가지:

1. **중복 홈 11군데.** 같은 핸들러가 두세 곳에 있다 — Record(mp4)는 상단바 Export·PlayView ● Record·카메라 인스펙터 ● Record 세 곳(`toggleShotRecording`, App.jsx 10122/10484/11240). FOV·Recenter는 뷰포트 바와 인스펙터 둘 다. Projects…(계층)과 Open Project…(프로젝트 메뉴). Add object(계층/Props 인스펙터). 재생 컨트롤(PlayView 바/타임라인/단축키).
2. **모드 게이팅이 반쪽.** `styles.css:7803-7820`이 헤더 레벨(IK/Foot/Body/속도/Clear/테이크 바)은 CSS로 숨기지만, 트랙 레벨(Prompts 레인 +, Full-Body Cut·트림·Retime)은 Scene/Camera 모드에도 그대로 남는다.
3. **죽은 게이트.** `advancedMode = true`(App.jsx:1174)가 PR #103의 초보자 토글을 하드코딩으로 죽였다(#119/#120: "Workflow가 첫 화면, Studio는 저작 도구"). `beginnerMode` 배관만 남아 있다.
4. **설정형 토글이 상단바에.** Auto Color·언어·Analytics는 문서를 바꾸는 동작이 아닌데 Save·Export와 같은 줄에 있다.

## 2. 결정 원칙 (각각 스크립트로 반증 가능)

- **R1 한 기능 한 집.** 동시에 보이는 두 영역에 같은 기능을 두지 않는다. 검사: 보이는 aria-label/title 집합에 중복 없음.
- **R2 편집 대상 게이팅.** 선택 가능한 것에 작용하는 컨트롤은 그것이 선택된 동안만 렌더한다. 모드 단위는 CSS로 두고(지금처럼), 선택 단위는 조건부 렌더로 바꾼다.
- **R3 비활성은 설명하거나 없앤다.** disabled 버튼은 `title`/`data-disabled-reason`에 전제 조건을 쓴다. 전제가 프로젝트 상태(리그 로드, 샷 ≥1, 카메라 키/모션)면 버튼을 렌더하지 않고 그룹 헤더가 힌트를 쓴다. 검사: 새 프로젝트 상단바에 disabled 0개.
- **R4 종류별 메뉴 하나.** 내보내기는 `Export ▾` 하나, 앱 설정은 `Settings` 하나, 뷰포트 표시 토글은 `View ▾` 하나. 텍스트 라벨, 포털 Dropdown(`ui.jsx:8-149`) 또는 fixed-anchor `.project-menu` 패턴(App 10425-10432). overflow:hidden 안의 `<details>`는 쓰지 않는다.
- **R5 주 경로는 보이고 나머지는 접는다.** 크리에이터 여정(배치 → 포즈/아이덴티티 → 프레이밍 → 컷/타이밍 → (선택) 모션 → 타깃 모델 확인 → 키프레임 팩 내보내기)에 있는 컨트롤은 해당 모드에서 항상 보이고, 그 밖은 한 클릭 아래. 정량 규칙이 아니다 — PostHog는 18개 UI 모듈이 미계측이고 사용자 90%가 계측 이전 버전이라 사용량으로 제거를 정당화할 수 없다(§5).
- **R6 모드 예산.** Scene ≤35 / Camera ≤38 / Motion ≤52 (기준 시나리오).
- **R7 드래그 수정자는 자기 모드 안에.** Foot snap·Body contact는 IK 드래그 해석만 바꾸므로 IK가 켜진 동안만 렌더. 두 토글은 독립 비트라 합치지 않는다(ik.js 901-995).
- **R8 죽은 게이트는 지운다.** `advancedMode`, `beginnerMode` 삭제.
- **R9 옮기면 이정표를 세운다.** 옮긴 컨트롤은 단축키를 새 라벨에 쓰고, 릴리스 노트에 새 위치를 적는다. (Figma UI3 플로팅 패널 되돌림, Blender 2.8 "어디 갔지" 스레드 — 사용자가 거부하는 건 단순화가 아니라 발견 가능성 없는 이동이다.)

## 3. 컨트롤별 결정표

범례: 유지 / 이동 / 접기 / 삭제. "새 라벨"에는 단축키를 함께 쓴다.

### v2 새 위치 (#533 기준 main)

아래 결정표는 v2 이전 기록이다. v2 셸에서 각 기능의 최종 집은 다음과 같다(§8 참고).

| 기능 | v2 집 |
|---|---|
| New / Open… / Save / Save As… | 상단바 **File** 메뉴; 저장 상태는 하단 상태 바 |
| Export ▾ (Keyframe pack, Video, Depth + normal, Storyboard, OTIO) | **File › Export ▸**, ⌘E = Keyframe pack; 진행률은 상태 바 |
| Settings (Language, Analytics) | **Edit › Preferences…** › General / Appearance; 모션 설정은 Preferences › ARDY Connection |
| View ▾ (Reference grid, Auto Color, Body part colours) | 뷰포트 **Show** 필 (+ Trails) |
| 카메라 선택 / 셰이딩 | 뷰포트 **Perspective** 필 / **Clay Lit** 필 |
| 모드 탭 Scene/Camera/Motion | 뷰포트 모드 툴바 **1 Stage / 2 Pose / 3 Camera / 4 Motion**, 모드별 도구 W/E/R |
| Sculpt (이미지로 조형, #739) | 뷰포트 모드 툴바 **5 Sculpt**: 선택한 sculpt 하나만 턴테이블에 격리(W/E/R = 정면/측면/뒷면), Details 맨 위 **Sculpt from image** 패널(참조 이미지 → Start → Measure/Draft/Score/Refine → Place in scene). UI 전용 모드라 바깥에는 Stage로 보인다 |
| IK on/off | **Pose 모드(2)** 진입이 IK를 켜고, 나가면 끈다 |
| Foot snap / Body contact | Pose 모드 동안 시퀀서 헤더 |
| 자동 수정(Pose fix, Auto Pose, Pin, Fit to platforms) | **Pose Details** (W Pose fix / E Auto Pose / R Pin), 미리보기 → Apply/Cancel |
| 테이크 바 Scene/Refine 카드 | 없음 (3.0에서 제거: Generate Motion과 캐럿 메뉴가 없고, 모션은 에이전트가 계산한다) |
| 테이크 버전 목록 | **Details › Takes** |
| + Add object (계층), Props + Add | 뷰포트 **+ Add**, **Content › Basic Shapes**; Outliner 우클릭 Create ▸ |
| Agent / Workflow | **Window** 메뉴 (Agent ⌘B) |
| Content / Log | 하단 독 탭 (Content는 접기 가능) |
| Root path (Waypoint, P) | 시퀀서 헤더 "Waypoint on/off" (라벨 "Root path") |
| Tutorial / Keyboard shortcuts / About | **Help** 메뉴 |

### 상단바 (7 → 5)
| 컨트롤 | 현재 | 결정 | 새 위치 / 라벨 | 규칙 | 영향 테스트 |
|---|---|---|---|---|---|
| 프로젝트 메뉴(New/Open/Save/Save As) | 상단바 | 유지 | — | R4 | verify-project-menu-browser:110-114 |
| Workflow 링크 | 상단바 | 유지 | — | 내비 | — |
| Save | 상단바 | 유지 | "Save ⌘S" | R5 | 동일 |
| Export(mp4, 정적 샷이면 disabled) | 상단바 | 접기 | `Export ▾` 항목 "Video (mp4)" — 샷/키/모션 중 하나라도 있을 때만 렌더. **프리플라이트**: 키 없는 샷은 현재 샷 카메라로 프레이밍 키를 만들거나 "Frame the shot first"로 거부; 모션 없으면 내보내기 범위 = 샷 [start,end] (timelineContentExtent가 샷을 무시해 360프레임을 뽑는 것 방지, timeline-extent.js:5-35 / camera-move.js:302-304) | R3/R4 | verify-project-menu-browser(`topbar-export` id는 트리거로), verify-layout:281 |
| (신규) `Export ▾` | — | 추가 | Save 오른쪽. 첫 항목이자 기본 = **Keyframe pack (zip)**; Video(mp4); Depth + normal; Storyboard (PNG); OTIO(샷 ≥1일 때만) | R4/R5 | 신규 browser test |
| Auto Color | 상단바 | 이동 | `View ▾`(뷰포트 바) 항목, 캡처 포함 경고를 title에 유지, className `.auto-color-toggle` 유지 | R4 | qa-auto-color-browser:70,94 / verify-auto-color:58 (메뉴 열기 스텝 추가) |
| 언어 토글 | 상단바 | 접기 | `Settings` → "Language: English / 한국어" (현재 표시). **첫 실행에 ko-KR이고 locale 미저장이면 Settings 트리거 라벨을 "한국어"로** | R4 + 첫 실행 단서 | verify-korean-ui:121 (컴포넌트 문자열 유지) |
| Analytics 토글 | 상단바 | 접기 | `Settings` → "Anonymous analytics: on/off", aria-pressed 유지, 2클릭 | R4 (GDPR 7(3)/ICO: 철회는 동의만큼 쉽게) | 신규: 옵트아웃 도달성 browser test |
| Live workspace 핸들(span) | 상단바 | 유지 | 컨트롤 아님 | — | — |

### 계층 패널 (16 → 12)
| 컨트롤 | 현재 | 결정 | 새 위치 / 라벨 | 규칙 | 영향 테스트 |
|---|---|---|---|---|---|
| Projects… | 계층 헤더 (App 10173) | 삭제 | 프로젝트 메뉴 "Open Project…"가 이미 있음 (c95d478이 지웠다가 3fa3006이 되돌린 행) | R1 | — |
| Scenes 블록(SceneSwitcher: 목록 + New Scene + Scene…) | 트리 위 | 이동 | 트리 루트 행의 **씬 선택 필**(필이 곧 행 이름; 이름을 두 번 쓰지 않는다)("SCENE 01 ▾", aria-label "Select scene", 포털 리스트박스, 키보드 탐색, + New scene). 왼쪽 펼침 캐럿과 구분. 루트 우클릭 = Rename/Duplicate/Delete(씬 문서 분기, CatalogueEntries로 빠지지 않음). F2 인라인 이름 변경은 onSceneRename으로. 씬 1개면 Delete 미렌더 + 키보드 호출 시 이유 토스트 | R1/R3 | verify-hierarchy, verify-project, qa-multichar-rig-browser, verify-beginner-screen |
| + Add object | 계층 | 유지 | — | R5 | — |
| 트리 행 8 + 캐럿 3 | 트리 | 유지 | — | — | — |

### 뷰포트 바
| 컨트롤 | 현재 | 결정 | 새 위치 / 라벨 | 규칙 | 영향 테스트 |
|---|---|---|---|---|---|
| 모드 탭 Scene/Camera/Motion | 바 | 유지 | title 문자열 그대로 | 내비 | qa-gvhmr-trajectory-browser:42 |
| 중앙 탭 Scene/PlayView (`.pane-tabs`) | 바 | 삭제 | `centerTab` → 내부 `preview` 상태. 진입점: embed(`?embed=playview`), PiP look-through. dualview의 playMode 분기(377-385: 샷캠 전체 페인, 기즈모 레이어 off, 레터박스, 인셋 없음)를 look-through가 타게 한다. 770-774 효과(프레임 0 + 자동재생) 유지. 빈 상태 CTA(11128-11136) 삭제(90일간 0회). mp4 export는 오프스크린이라 preview 불필요 | R1 | verify-timeline-camera:44-45, verify-layout:37-38 (계약 문자열 갱신), verify-label-tooltips:10-11 (타임라인 복사본으로 충족), verify-cozy-scene-node:23 (Workflow 쪽 무변경) |
| Move/Rotate/Scale, Snap | 바 (Scene) | 유지 | "Move W / Rotate E / Scale R", "Snap (Ctrl로 반전)" | R5 | verify-object-gizmo:212,280,302 |
| Grid | 바 | 접기 | `View ▾` "Reference grid", className `.grid-view-switch` 유지 | R5 | qa-grid-view-browser:56 (메뉴 열기 스텝) |
| Shot/Cam/Ratio/FOV/Recenter/Top ▾ | 바 (Camera) | 유지 | "Recenter on subject (F)" | R5 | verify-layout:36 |
| (신규) `View ▾` | — | 추가 | 바 오른쪽 끝, 전 모드. Reference grid · Auto Color · Body part colours(off/shaded/flat, 캐릭터 선택 시만 렌더). 켜진 토글이 있으면 트리거에 점 표시 | R4 | 신규 |
| PlayView 바 prev/play/next | play 바 | 삭제 | 타임라인 트랜스포트(Space/J/K) | R1 | — |
| PlayView 바 OTIO | play 바 | 이동 | `Export ▾` "OTIO cut list" | R4 | — |
| PlayView Export 메뉴(keyframe/depth/storyboard) | play 바 | 이동 | `Export ▾` 상단바(블록 그대로 리프트, `export-menu-trigger` id 유지) | R4 | — |
| PlayView ● Record | play 바 | 삭제 | `Export ▾` Video | R1 | — |
| PiP: 가이드 순환, look-through | PiP | 유지 | "Look through"로 샷 카메라 비행에 진입. 화면 위 "Shot camera" 표시나 Esc로 복귀. 상단 바에 중복 토글 없음. 크롬 없는 플레이어는 embed | — | qa-preview-browser |

### 인스펙터
| 컨트롤 | 현재 | 결정 | 새 위치 / 라벨 | 규칙 | 영향 테스트 |
|---|---|---|---|---|---|
| 카메라 FOV + Recenter | 인스펙터 | 삭제 | 뷰포트 카메라 바가 집. **전제: 카메라를 선택하면(계층 행, 샷 블록, PiP) workflowMode를 camera로 자동 전환** — 지금은 `selectHierarchy`(1351-1367)와 `selectTimelineShot`(4830-4848)이 모드를 안 바꿔서 Scene 모드에선 바 컨트롤이 CSS로 숨는다 | R1 | verify-object-gizmo:391,440,923,1184 (뷰포트 aria-label로 재지정), 신규 source-contract |
| 카메라 ● Record | 인스펙터 | 삭제 | `Export ▾` Video | R1 | — |
| Target model | 인스펙터 | 유지 | "Cut for" | R5 | — |
| Part colours | Motion 인스펙터 | 이동 | `View ▾`(캐릭터 선택 시만) | R1/R4 | verify-part-colours(로직만, 무영향) |
| Subject / + Add second / Open pose studio | 인스펙터 | 유지 | — | R5 | — |
| 캐릭터 Transform(9 입력) | 인스펙터 | 접기/재구성 | Scene 모드: 기본 닫힘(기즈모+M/R/S가 주 경로). Motion 모드: M/R/S가 이미 CSS로 숨어 있으므로(styles 7803-7810) **"Placement (무대 위치; 테이크는 안 바꿈)" 컴팩트 행(Position X/Z + Rotation, 4개)으로 열어 둠**. `selectWorkflowMode('motion')`이 그룹이 아니라 활성 캐릭터 행을 선택하도록 한 줄 수정(기즈모 활성). **오브젝트 Transform(12267)은 열린 채 유지** — verify-object-gizmo:133이 읽음. 후속 이슈: 로드된 테이크에서 배치 드래그가 clip.anchor가 아니라 entry.x/z만 바꾸는 기존 함정(App 4184-4214 vs 1045-1054) | R5 | verify-object-gizmo:133 |
| Rig / Pose / Video capture / Prompt Blocks 폴드아웃 | 인스펙터 | 유지(닫힘) | — | — | — |
| Prompt Blocks: Generate all | 폴드아웃 | 삭제 (#550) | 없음 (3.0에서 톱바 `Generate Motion` 버튼 제거) | R1 | verify-layout, generation-browser-smoke |

### 타임라인
| 컨트롤 | 현재 | 결정 | 새 위치 / 라벨 | 규칙 | 영향 테스트 |
|---|---|---|---|---|---|
| prev/play/next, zoom, collapse | 헤더 | 유지 | Space/J/K | R5 | verify-label-tooltips |
| Root path(Waypoint, P) | 헤더 | 유지 — 전 모드 | `advancedMode &&` 래퍼만 제거. Scene 모드 스테이징에도 쓰는 컨트롤(skeptic A) | R8 | — |
| Prompts 레인 + | 트랙 | 게이팅 | Motion 모드에서만 렌더 | R2 | qa-advanced-toggle-browser:20 (구 게이트 QA → PR1에서 정리) |
| Full-Body Cut(1973)·Retime(2246)·트림 핸들 | 트랙 | 게이팅 | Motion 모드 + 세그먼트 선택 시만 | R2 | motion trim 테스트(PR2에서 grep) |
| 샷 Cut/Split/경계 | 샷 블록 | 유지(선택 게이팅) | — | R2 | verify-timeline-camera |
| + Add shot | 헤더 | 유지 | — | R5 | — |
| IK | 헤더(Motion) | 유지 | `ikChains` 없으면 미렌더 + 헤더 힌트 "리그를 로드하면 포즈 편집"; 텍스트 "IK on/off" 유지 | R3 | verify-ik-browser:151,227,234,324 |
| Foot snap / Body contact | 헤더 | 접기 | IK 켜진 동안만, **두 토글 그대로**(독립 비트: App 1312-1313, 5998, 6031-6046) | R7 | verify-ik-browser:90 (IK 켜기 스텝 추가) |
| Segment speed / Clear motion | 헤더 | 게이팅 | 세그먼트 선택 / 모션 로드 시 조건부 렌더 | R2/R3 | — |
| 테이크 바 Scene/Refine + 버전 | 테이크 바 | 유지 | 이미 aria-disabled + 이유 | R3 | — |

## 4. 메뉴 설계
- **`Export ▾`** (상단바, Save 오른쪽; 트리거에 `data-testid="export-menu-trigger"` + id `topbar-export`): 1 Keyframe pack (zip) · Shift: 모든 샷 [기본/굵게] · 2 Video (mp4) [샷/키/모션 있을 때] · 3 Depth + normal passes · 4 Storyboard (PNG) · 5 OTIO cut list [샷 ≥1] · 항목이 빠지면 푸터 한 줄 힌트. "Send to AI"는 넣지 않는다 — Workflow의 Send to AI는 같은 팩을 다운로드하는 postMessage(CozySceneNode.jsx:51-56)라 중복(R1).
- **`Settings`** (상단바 맨 오른쪽, 라벨 텍스트): Language English/한국어(현재 표시) · Anonymous analytics on/off. 문서를 바꾸는 항목은 절대 안 넣는다.
- **`View ▾`** (뷰포트 바 오른쪽 끝, 전 모드): ☐ Reference grid · ☐ Auto Color("켜둔 동안 캡처에 포함") · Body part colours off/shaded/flat(캐릭터 선택 시). 가이드 순환은 PiP 전용이라 여기 중복하지 않음.

## 5. 증거 요약
- **사용 데이터(PostHog 90일 = 전체 16일, QA 제외)**: 세션 120명 → 첫 편집 50 → 씬 생성 13 → 내보내기 10. 첫 편집의 94%는 "오브젝트 드롭". activation:completed 9/9 전부 export 경로. feature:used는 14명·7기능뿐(camera_fly 10, timeline_scrub 9, orbit 7이 상위 3). 사용자 110명(1.6.0)은 계측 이전 빌드, 페이지뷰 74%는 개발자 로컬호스트. → 사용량으로 특정 컨트롤 제거를 정당화하지 않는다. 이 문서의 삭제·이동은 텔레메트리 결론이 아니라 R1~R9와 코드·패턴 근거에 선 설계 가설이며, 출시 후 새 위치(Export ▾ 항목, Settings, View ▾)의 노출·완료 계측으로 검증한다. 계측 버그: `export_keyframe_pack/export_render_pass/export_storyboard`가 FEATURE_NAMES(analytics.js:32-36)에 없어 영원히 0 — 후속 이슈.
- **경쟁/OSS 패턴**: three.js 에디터 툴바 = 이동/회전/크기 3개뿐, 동사는 메뉴바, 설정은 사이드바 Settings 탭; Babylon inspector-v2는 기즈모 하위 컨트롤을 `<Collapse visible={!!gizmoMode}>`; Blender는 Toolbar/Header/Sidebar 영역 + 모드가 도구를 게이팅, 렌더/내보내기는 메뉴; Cascadeur는 Settings > Toolbar Visible로 전문가 도구 옵트인; Spline 툴 독 = 추가+변환, Export 우상단; Unreal Sequencer 툴바 = Create Camera + Render + 드롭다운 설정. LTX Studio는 샷 컨트롤을 Camera/Keyframes/References 셋으로 압축.
- **UX 원칙(측정 근거만)**: Carroll 'training wheels'(NN/g 요약, 1차 논문 미회수): 제한된 초기 UI가 초기 과제 26/21% 빠름, 지식 +69/+21%, 이후 고급 과제 52% 빠름. 아이콘 밀도 연구(INTERACT 2015): 한 영역 ≤25개. NN/g progressive disclosure: 2단계 초과는 유용성 낮음, 함께 쓰는 옵션은 붙여둔다.
- **반발 사례**: Figma UI3(2024)는 플로팅 패널을 되돌리고 구 UI 복귀 경로를 열었다; Blender 2.8은 "어디 갔지" 스레드가 많았지만 단축키/키맵이 남아 되돌리지 않았다; Resolve Cut 페이지는 "러프컷 도구"로 이해될 때만 받아들여졌다. 결론: 위치·어휘·모드가 바뀔 때 이정표가 없으면 반발한다(R9).

## 6. 지우지 않는 것 (명시)
IK/물리/Prompt Blocks/Video capture/Rig Control/OTIO/Depth·normal/Storyboard/Part colours/Waypoint/크레인·돌리 그래프 — 전부 남는다. 위치가 바뀌거나(메뉴), 대상이 선택된 동안만 보이거나(조건부 렌더), 접힐 뿐이다. `window.__cozyclay` QA 훅과 MCP/agent 커맨드는 DOM을 쓰지 않으므로 무영향.

## 7. 구현 계획 (PR 순서 = 위험 순서, App.jsx는 절대 병렬 작업 금지)
| PR | 파일/영역 | 내용 | 갱신 테스트 | 위험 |
|---|---|---|---|---|
| 1 (#190 → PR #196) | App.jsx:1174, 10191, Foldout `hidden={!advancedMode…}` 9곳(11211-12226), timeline.jsx:1066, hierarchy-panel beginnerMode prop | 죽은 게이트 삭제 | qa-advanced-toggle-browser 정리, verify-beginner-screen 확인 | 없음 |
| 2 (#191 → PR #198) | timeline.jsx만 | Prompts + Motion 전용; Full-Body Cut/Retime/트림 세그먼트 선택 시; speed/Clear 조건부; IK 미렌더-until-rig; Snap/Contact는 IK on 안에 | verify-ik-browser:90,151,227,234,324 | 낮음 |
| 3 (#192 → PR #197, 테스트 후속 #202) | hierarchy-panel.jsx + App.jsx:10166-10176 | Projects… 삭제; SceneSwitcher → 루트 행 씬 선택 필 + 컨텍스트 메뉴 씬 분기 (§3 계층 AC 4개) | verify-hierarchy, verify-project, qa-multichar-rig-browser | 중 |
| 4 (#193 → PR #200) | App.jsx 상단바 10079-10165 + play 바 10395-10490 + 인스펙터 Record 11232-11242 + FOV/Recenter 11225-11231 + selectHierarchy/selectTimelineShot + runShotExport 프리플라이트 | `Export ▾`(Keyframe pack 우선, Video 조건부 + 정적 샷 프리플라이트, OTIO 조건부), `Settings`(첫 실행 한국어 단서), play 바 트랜스포트/Record/OTIO 삭제, 인스펙터 Record/FOV/Recenter 삭제, **카메라 선택 → Camera 모드 자동 전환** | verify-project-menu-browser:110-114, verify-layout:36,281, verify-object-gizmo Recenter 4곳, 신규 3건: 옵트아웃 도달성·카메라 선택 모드 전환·키 없는 40프레임 정적 샷 → 40프레임 mp4 | 중 |
| 5 (#194 → PR #201) | App.jsx 뷰포트 바 10233-10310 + Part colours ~11290 + styles.css 8713-8794 | `View ▾`(Grid/Auto Color/Part colours), 캐릭터 Transform 기본 닫힘 | qa-auto-color-browser:70,94, verify-auto-color:58, qa-grid-view-browser:56 | 낮음 |
| 6 (#195 → PR #204) | App.jsx pane-tabs 10233-10252 + centerTab 참조(742-774, 6471, 6525, 6644, 10078, 10544, 10684, 10865-10897, 10938-10941, 11018, 11066, 11091-11100, 11128-11136) + dualview.jsx 377-405 + styles `.pane-tabs` | **명시적 상태기계**: `enterPreview()` = preview on + 프레임 0 + 모션 있으면 자동재생 + lookThrough on; `exitPreview()` = 전부 해제 + 일시정지. PiP look-through 버튼 → enterPreview, Esc/PiP 닫기 → exitPreview. dualview는 preview를 playMode 분기(377-385)로 라우팅. embed 초기화(742/758)도 enterPreview 경로. CTA 삭제. `globalThis.playMode` = preview로 유지 | verify-timeline-camera:44-45, verify-layout:37-38 계약 문자열 재작성; verify-cozy-scene-node:22-23 무변경; 브라우저 증명: enter → 기즈모 레이어 없음 + 레터박스, exit → 편집 크롬 복귀; /workflow/ embed QA | 중 |

PR4가 새 집을 먼저 세우고 PR5/6이 옛 집을 허문다(R9). 완료 후 `tools/qa/studio-control-count.mjs`를 main에서 재실행해 §1 표의 "목표" 열을 실측으로 바꾼다.

## 9. 미해결
- 로드된 테이크에서 배치(Placement) 드래그가 clip.anchor가 아니라 entry.x/z만 바꾸는 기존 함정(App 4184-4214 vs 1045-1054) — #201에서 발견, 미수정.
- `test/verify-object-gizmo.mjs` 스토리지 섹션이 레거시 키 `cozyclay.scene.v1`을 시드하는데 scenes.js는 9d7ea8e부터 `cozyclay.scenes.v4`를 쓴다 — observation 티어 스위트의 기존 실패, #202가 :356 셀렉터만 고침.
- Full-Body 레인의 IK 키 `+`는 IK를 켠 채 Scene/Camera로 가면 여전히 렌더된다(#198에서 보고).
- `.film-frame`과 "SUBJECT OUT OF FRAME" 캡션은 look-through-without-preview에 게이팅돼 있으며, Look through는 그 경로로 들어간다.
- 카메라 바 Follow 하위 필드(거리/시작점/스무딩/look-ahead) `Follow ▾` 접기 — 샷 선택 Camera 47이 문제로 판단될 때만.
- 분석 계측: FEATURE_NAMES 누락 3건, featureNamesSeen 원샷 게이트(페이지 로드당 1회 도달 지표), 18개 UI 모듈 미계측 — 별도 이슈.
- Carroll 1984 1차 논문·Blender 2.8 설계 문서·Jensen Harris 리본 강연 원문 미회수(archive.org 429). 본문 수치는 2차 출처 표기.

## 8. v2 shell

The v2 shell has one mode toolbar with four modes. Key `1` is **Stage**
(`workflowMode: "scene"`), `2` is **Pose** (`"pose"`, the IK mode), `3` is
**Camera** (`"camera"`), and `4` is **Motion** (`"motion"`). W/E/R select the
current mode's tools; the active mode shows its name and inactive modes show
only their digit.

The menu map follows G7/G8. **File** holds New, Open…, Save, Save As… and
Export ▸ (Keyframe pack, Video, Depth + normal, Storyboard and conditional
OTIO). **Edit** holds Undo, Redo and Preferences…. **Window** holds Agent,
Content and Log. **Help** holds Tutorial, Keyboard shortcuts and About. The
viewport **Show** pill owns Reference grid, Auto Color, Body part colours and
Trails; Perspective owns camera selection and Clay Lit owns shading. Language,
Analytics and Motion setup live in Preferences under General › Appearance and
Motion › ARDY Connection.

The project mode has two homes. The **mode badge** (`Storyboard` / `Animation`)
sits in the top bar under the save state, read-only: the mode is chosen on the
start screen, not switched in place. In a storyboard project the **Generate**
group leaves the top bar and the viewport toolbar offers modes 1-3 only (key `4`
and `view.setMode motion` are refused with a reason). The **Board** tab is the
home of the panels, below.

The bottom dock's tabs follow the project mode. An animation project keeps
**Animation | Assets**. A storyboard project shows **Board | Assets** and opens
on Board. Board is the home of the storyboard panels: one card per still in
still order, each with its thumbnail, caption, hold and the card actions
(Duplicate, Delete, Stylize, Send to Workflow, Export). `+ Panel` adds a
panel, a drag reorders the panels, and Delete on a focused card removes it.
The card actions show on hover or focus, so Board adds no always-visible
controls beyond `+ Panel`.

G10 leaves exactly two visible add routes: viewport **+ Add** (the object
catalogue plus Character and Camera) and **Content › Basic Shapes** (drag or
double-click a primitive). The Outliner right-click **Create ▸** accelerator
remains available.

The removed controls are the old take-bar Scene/Refine cards and their duplicate
IK toggles (`IK on/off`, Foot snap and Body contact in the old header), the
hierarchy `AddObjectMenu` / **+ Add object** button, and the Props inspector
`AddObjectMenu` / **+ Add** button. Their actions live in the mode toolbar,
Pose Details, Generate Motion/File menus, viewport + Add, Content, or the
Outliner context menu as defined above.
