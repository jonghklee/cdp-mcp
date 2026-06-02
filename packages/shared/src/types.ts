// Base error class
export class CdpMcpError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
    this.name = 'CdpMcpError';
  }
}

// Result type (discriminated union)
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: CdpMcpError };

// Execution context
export type ExecutionContext = 'page' | 'content' | 'worker' | 'popup';

// Tool namespace
export type ToolNamespace = 'cdp' | 'site' | 'debug' | 'pattern' | 'ext' | 'product' | 'qa';

// CDP common types
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  type: string;
  attached: boolean;
}

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  browserContextId?: string;
}

export interface SessionInfo {
  sessionId: string;
  targetId: string;
  type: string;
}

// ── Session Sharing ─────────────────────────────────────────

/**
 * Connection mode for CDP session.
 * - owner: Chrome 라이프사이클 관리 (launch, lock, close)
 * - shared: 연결만 (lock 없음, Chrome 종료 안 함)
 */
export type ConnectionMode = 'owner' | 'shared';

/**
 * 직렬화 가능한 세션 정보.
 * 부모 → subagent 간 Chrome 세션 공유에 사용.
 */
export interface SessionDescriptor {
  /** Chrome 디버그 포트 (최소 필수) */
  port: number;
  /** 세션 고유 ID */
  sessionId: string;
  /** 부모 Claude Code PID */
  ownerPid: number;
  /** Chrome 프로세스 PID */
  chromePid?: number;
  /** 현재 활성 탭 ID (힌트) */
  activeTabId?: string;
  /** 익스텐션 ID (힌트) */
  extensionId?: string;
  /** 인덱싱/필터링용 태그 */
  tags?: Record<string, string>;
  /** export 시점 타임스탬프 */
  exportedAt: number;
}

/**
 * CDP 쓰기 카드 정보.
 * 한 시점에 하나의 에이전트만 쓰기 가능.
 */
export interface CardInfo {
  /** 카드 보유 에이전트 식별자 */
  holder: string;
  /** 카드 보유 프로세스 PID */
  pid: number;
  /** 카드 획득 시점 */
  acquiredAt: number;
  /** 사용 목적 (디버깅용) */
  purpose?: string;
}
