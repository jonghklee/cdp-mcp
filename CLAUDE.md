# CDP-MCP

CDP(Chrome DevTools Protocol)를 MCP로 감싸서 AI가 브라우저를 제어하는 도구.

## 아키텍처
```
QA Layer → 익스텐션 기능 검증
Layer 3  → 특정 익스텐션 전용 (ChatLens 등)
Layer 2  → 사이트 지식 축적/분석
Layer 1  → 순수 브라우저 제어 (범용)
```

의존: QA → 3 → 2 → 1. pnpm monorepo, TypeScript strict.

## 공유 크롬 규칙 (중요)

- 모든 cdp-mcp 서버(에이전트)가 **창 없는 크롬 하나**를 같이 쓴다. 포트 9227 고정(env `CDP_MCP_PORT`), 데이터 폴더 `~/.cdp-mcp/chrome-profiles/shared`.
- 에이전트마다 창 하나. 탭 목록·전환·닫기·현재 탭은 자기 창(과 자기 탭이 연 팝업)만 본다.
- 크롬을 화면 앞으로 올리는 도구·옵션은 없다. 사람에게 보여 줄 때는 `cdp_show` 가 주소만 돌려준다.
- 켤 때마다 평소 크롬 프로필에서 Preferences·Secure Preferences·Cookies·Login Data·Local Storage 만 복사한다. 실행 중에는 바뀐 쿠키만 가져온다(`cdp_sync_profile`).
- 마지막 에이전트가 끝나면 크롬을 끄고 복사본을 지운다. lease 는 `~/.cdp-mcp/leases/<pid>.json`.
- 종단 시험: `node scripts/e2e-shared-chrome.mjs` (시험 전용 포트·폴더, 화면 맨 앞 노출 0회 확인 포함).

## 핵심 규칙

- 각 모듈은 MCP 없이도 import 가능해야 한다 (단위 테스트 가능)
- 실행 컨텍스트 4종: page, content_script, service_worker, popup
- 텍스트 입력: 에디터 감지 → 최적 방식 자동 판별
- Namespace: cdp_* (Core), site_* (Intelligence), qa_* (QA), ext_* (Extension)

## 스펙 문서

- 전체 구현 명세: docs/spec.md
- QA Layer 명세: docs/qa-layer-spec.md
- 현재 Phase 태스크: docs/tasks/ 하위 파일
- 진행 상황: docs/progress/ 하위 파일

## 테스트 규칙

- 모든 모듈: vitest 단위 테스트 필수
- 모든 tool 추가 후: MCP Inspector로 수동 확인
- Phase 끝: E2E 통합 테스트
- 구현 후 반드시 `pnpm test` 실행해서 통과 확인

## 스크립트

- pnpm test — vitest 단위 테스트
- pnpm inspect — MCP Inspector 실행
- pnpm test:e2e — Chrome 연결 + 실제 사이트 테스트

## 현재 상태

공유 창 없는 크롬 구조 (2026-11-12)
