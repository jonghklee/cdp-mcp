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

## 포트 규칙 (중요)

- cdp-mcp 전용 포트 범위: **9250~9278** (env `CDP_MCP_PORT=9250`)
- chrome-devtools 등 다른 CDP MCP는 9222 사용 → 절대 겹치지 않음
- cdp-mcp는 자기 lock이 있는 Chrome에만 재연결, 남의 Chrome에 연결 금지
- 포트 변경 시 `.mcp.json`의 `CDP_MCP_PORT` 환경변수 수정
- **cdp_reconnect로 포트 지정 시**: 반드시 confirm 없이 먼저 호출 → 탭 목록/lock 정보를 사용자에게 보여주고 확답 받은 후 confirm=true로 재호출
- **Chrome 프로세스 강제 종료 금지**: cdp-mcp는 절대로 Chrome을 kill하지 않음. 연결만 끊고 lock만 해제. Chrome 종료는 사용자가 직접 수행

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

Phase: 1 (Core 기반)
진행: 시작 전
