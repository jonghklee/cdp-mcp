# MCP 도구 상호작용 패턴 가이드

> MCP 서버에 도구가 많아지면, AI 모델이 올바른 도구를 선택하고 조합하는 데 어려움을 겪는다.
> 이 문서는 실제 운영 중인 MCP 서버(chrome-devtools, google-sheets, cdp-mcp)에서 발견된 패턴을 정리한 것이다.

---

## 프롬프트: MCP 도구 설계 시 상호작용 복잡성 해결

아래 프롬프트를 MCP 서버 설계 시 참고하거나, AI에게 MCP 도구 설계를 요청할 때 사용할 수 있다.

---

### 프롬프트 시작

```
당신은 MCP(Model Context Protocol) 서버의 도구(tool)를 설계하는 전문가입니다.
MCP 서버에 도구가 많아지면 AI 모델이 다음과 같은 어려움을 겪습니다:

1. 어떤 도구를 선택해야 할지 모른다
2. 도구 간 호출 순서를 파악하기 어렵다
3. 한 도구의 출력을 다른 도구의 입력으로 전달하는 방법을 모른다
4. 불필요하게 많은 도구 호출을 하게 된다
5. 도구가 50개 이상이면 컨텍스트 윈도우를 낭비한다

이 문제를 해결하기 위해 다음 7가지 패턴을 적용하세요.

---

## 패턴 1: ID 체인 (Snapshot → ID → Action)

**문제**: 도구 A의 결과를 도구 B가 참조해야 하는데, AI가 연결 방법을 모른다.

**해결**: 발견 도구가 고유 ID를 생성하고, 행동 도구가 그 ID를 소비한다.

**적용 방법**:
- 발견 도구(snapshot, list)의 반환값에 고유 식별자(uid, id)를 포함시킨다
- 행동 도구(click, edit, delete)의 파라미터에 같은 식별자를 받는다
- 도구 설명에 "이 ID는 {발견 도구 이름}에서 반환된 값을 사용하세요"라고 명시한다

**예시**:
```json
// 발견 도구
{ "name": "list_items", "returns": [{"id": "item_1", "name": "..."}, ...] }

// 행동 도구
{ "name": "update_item", "params": {"id": "item_1에서 받은 ID", "value": "..."} }
```

**설명문 작성법**:
```
name: list_items
description: "항목 목록을 반환합니다. 각 항목에는 고유 id가 포함되며,
             update_item, delete_item 등의 도구에서 이 id를 사용합니다."

name: update_item
description: "항목을 수정합니다. id는 list_items에서 반환된 값을 사용하세요."
```

---

## 패턴 2: 컨텍스트 설정 (Select → Act)

**문제**: 여러 대상(페이지, 문서, 세션)이 있을 때, 매번 대상을 지정하기 번거롭다.

**해결**: 두 가지 방식 중 도메인에 맞는 것을 선택한다.

### 방식 A: Stateful (세션 기반)
한 번 설정하면 이후 도구들이 자동으로 해당 컨텍스트에서 실행.
```
select_page(pageId: 3)    → 이후 모든 도구가 page 3에서 실행
click(uid: "btn_1")       → page 3의 버튼 클릭 (pageId 생략 가능)
```
**적합한 경우**: 한 대상에서 연속 작업 (브라우저 페이지, 터미널 세션)

### 방식 B: Stateless (매번 명시)
모든 호출에 대상 ID를 포함.
```
edit_cell(spreadsheetId: "abc", cellAddress: "B2", value: "hello")
edit_cell(spreadsheetId: "xyz", cellAddress: "A1", value: "world")
```
**적합한 경우**: 여러 대상을 병렬 처리 (스프레드시트, 데이터베이스)

### 방식 C: 하이브리드 (기본값 + 재정의)
기본 대상을 자동 선택하되, 필요 시 재정의 가능.
```
read_data()                        → 기본 시트(첫 번째)에서 읽기
read_data(sheetName: "Reports")   → 특정 시트 지정
```
**적합한 경우**: 80%가 단일 대상 작업이고 20%만 다중 대상 (문서의 기본 탭)

---

## 패턴 3: 목록→상세 (List → Get)

**문제**: 전체 데이터를 한 번에 반환하면 너무 크고, 반대로 ID를 모르면 시작할 수 없다.

**해결**: 목록 도구(요약)와 상세 도구(전문)를 분리한다.

```
list_items(filter?, pageSize?, pageIdx?)  → [{id, summary}, ...]
get_item(id)                              → {full detail}
```

**필수 요소**:
- 목록 도구: 페이지네이션(pageIdx, pageSize), 필터링(type, status)
- 상세 도구: 목록에서 받은 ID로 전체 정보 조회
- 목록은 핵심 필드만(id, name, status), 상세는 전부

**설명문 작성법**:
```
name: list_orders
description: "주문 목록을 반환합니다. 각 항목에는 orderId가 포함됩니다.
             상세 정보는 get_order(orderId)를 사용하세요.
             USE WHEN: 주문 ID를 모를 때, 목록을 탐색할 때
             DON'T USE WHEN: 이미 orderId를 알고 있을 때 → get_order 사용"
```

---

## 패턴 4: 복합 도구 (Compound Tool)

**문제**: 자주 함께 쓰이는 도구 조합이 있어서 매번 여러 번 호출해야 한다.

**해결**: 자주 쓰이는 조합을 하나의 복합 도구로 제공한다.

### 방식 A: 배치 (Batch)
같은 작업을 여러 대상에 수행.
```json
{
  "name": "fill_form",
  "params": {
    "elements": [
      {"uid": "name_input", "value": "홍길동"},
      {"uid": "email_input", "value": "hong@example.com"}
    ]
  }
}
```

### 방식 B: 파라미터 기반 합성
하나의 도구가 모드에 따라 다른 전략을 자동 선택.
```json
{
  "name": "type_text",
  "params": {
    "selector": "#editor",
    "text": "hello",
    "method": "auto"  // auto | keyboard | clipboard | execCommand
  }
}
// "auto"는 내부적으로: 에디터 감지 → 최적 방식 선택 → 실행
```

### 방식 C: 파이프라인
여러 단계를 하나로 묶음.
```json
{
  "name": "navigate_and_wait",
  "params": {
    "url": "https://example.com",
    "waitFor": "네트워크 요청 완료",
    "screenshot": true
  }
}
// 내부: navigate → waitForNetworkIdle → screenshot
```

**기준**: 3회 이상 함께 호출되는 패턴이 보이면 복합 도구로 만든다.

---

## 패턴 5: 액션 후 상태 반환 (includeSnapshot)

**문제**: 행동 → 확인 → 다음 행동 사이클에서 "확인" 호출이 중복된다.

**해결**: 행동 도구에 선택적으로 변경된 상태를 함께 반환하는 옵션을 제공한다.

```json
{
  "name": "click",
  "params": {
    "uid": "submit_btn",
    "includeSnapshot": true  // 선택적 (기본: false)
  },
  "returns": {
    "clicked": true,
    "snapshot": { ... }  // includeSnapshot=true일 때만 포함
  }
}
```

**효과**: `click` + `take_snapshot` 2회 호출 → 1회로 축소
**주의**: 기본값은 false로 두어, 상태가 필요 없는 경우 성능 저하를 방지

---

## 패턴 6: 읽기 세분화 (Multi-Granule Read)

**문제**: 하나의 read 도구로 모든 조회를 처리하면 과도한 데이터가 반환된다.

**해결**: 읽기 도구를 조회 범위별로 분리한다.

```
read_all()              → 전체 데이터 (탐색 시작 시)
read_schema()           → 구조/스키마만 (헤더, 컬럼 정의)
read_range(start, end)  → 특정 범위 (페이지네이션)
read_fields(['A','C'])  → 특정 필드만 (선택적 추출)
```

**적용 기준**:
| 데이터 규모 | 추천 세분화 수준 |
|------------|-----------------|
| < 100행    | read_all 하나로 충분 |
| 100~1000행 | read_all + read_range |
| > 1000행   | 4단계 전부 |

---

## 패턴 7: 도구 설명 기반 라우팅 (Description Routing)

**문제**: 도구가 20개 이상이면 AI가 올바른 도구를 선택하기 어렵다.

**해결**: 도구 설명(description)에 사용 조건과 대안을 명시한다.

### 기본 템플릿:
```
name: {tool_name}
description: "{한 줄 요약}.

USE WHEN: {이 도구를 써야 하는 구체적 상황 2-3가지}
DON'T USE WHEN: {다른 도구를 써야 하는 상황 + 대안 도구 이름}
REQUIRES: {선행 조건 - 예: take_snapshot을 먼저 호출}
RETURNS: {반환값 중 다른 도구에서 사용할 수 있는 필드}"
```

### 실제 예시:
```
name: take_snapshot
description: "현재 페이지의 접근성 트리 기반 텍스트 스냅샷을 생성합니다.
             각 요소에 고유 uid가 부여됩니다.
             항상 최신 스냅샷을 사용하세요.

USE WHEN: 페이지 구조를 파악할 때, 클릭/입력할 요소를 찾을 때
DON'T USE WHEN: 시각적 확인이 필요할 때 → take_screenshot 사용
REQUIRES: select_page로 대상 페이지가 선택되어 있어야 함
RETURNS: uid (click, fill, hover 등에서 사용)"
```

### 도구 간 관계 명시:
```
name: select_page
description: "...
RELATED: list_pages(페이지 ID 조회) → select_page(컨텍스트 설정) → take_snapshot(요소 탐색)"
```

---

## 보너스: 도구 수가 50개 이상일 때 — 지연 로딩

**문제**: 모든 도구를 한 번에 등록하면 AI의 컨텍스트 윈도우를 낭비한다.

**해결**: 핵심 도구만 항상 로드하고, 나머지는 태그 검색으로 온디맨드 로드한다.

```
항상 로드 (8개): navigate, click, type, read, screenshot, list, search, evaluate
지연 로드 (42개): 태그 기반 검색

// AI가 필요한 기능을 설명하면 → 태그 매칭 → 도구 로드
AI: "DOM 변경을 실시간 모니터링하고 싶어"
시스템: tags ["dom", "watch", "mutation"] → dom_watch_start 도구 로드
```

**태그 설계 원칙**:
- 도구당 3-5개 태그
- 동의어 포함: ["edit", "modify", "update", "change"]
- 계층적: ["network", "network.request", "network.response"]

---

## 패턴 적용 체크리스트

MCP 서버를 설계할 때 이 체크리스트를 사용하세요:

- [ ] **ID 체인**: 발견 도구 → 행동 도구 간 ID 흐름이 명확한가?
- [ ] **컨텍스트**: 대상 지정 방식(stateful/stateless/hybrid)을 결정했는가?
- [ ] **목록→상세**: 큰 데이터를 다루는 도구에 목록/상세가 분리되어 있는가?
- [ ] **복합 도구**: 3회 이상 함께 호출되는 패턴을 하나로 합쳤는가?
- [ ] **상태 반환**: 행동 후 확인이 필요한 도구에 includeSnapshot 옵션이 있는가?
- [ ] **읽기 세분화**: 데이터 규모에 맞게 읽기 도구가 세분화되어 있는가?
- [ ] **설명 라우팅**: 모든 도구 설명에 USE WHEN / DON'T USE WHEN이 있는가?
- [ ] **지연 로딩** (50개+): 핵심 도구 외 나머지가 태그 기반 로드인가?

---

## 패턴 비교표

| 패턴 | chrome-devtools | google-sheets | cdp-mcp |
|------|----------------|---------------|---------|
| ID 체인 | uid (스냅샷 기반) | - | selector (직접) |
| 컨텍스트 | Stateful (select_page) | Stateless (매번 명시) | Hybrid (자동 감지 + 재정의) |
| 목록→상세 | list/get + 페이지네이션 | list_sheets | listTabs + getActiveTab |
| 복합 도구 | fill_form | edit_row (배치) | type auto (전략 자동) |
| 상태 반환 | includeSnapshot | - | - |
| 읽기 세분화 | snapshot vs screenshot | 4단계 (all/headings/rows/cols) | - |
| 설명 라우팅 | 부분 적용 | 미적용 | 계획 중 (USE WHEN) |
| 지연 로딩 | 미적용 | 미적용 | 계획 중 (태그 기반) |
```

### 프롬프트 끝

---

## 라이선스

이 문서의 패턴은 실제 운영 중인 MCP 서버에서 추출한 것이며, 자유롭게 사용할 수 있습니다.
