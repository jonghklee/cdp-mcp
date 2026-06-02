import type { ConnectionPool } from '../cdp/connection-pool.js';
import { screenshot, type ScreenshotResult } from '../observe/screenshot.js';
import { getPageInfo, type PageInfo } from '../observe/page-info.js';

export interface SnapshotOptions {
  screenshot?: boolean;
  pageInfo?: boolean;
}

export interface PostActionSnapshot {
  screenshot?: ScreenshotResult;
  pageInfo?: PageInfo;
}

/**
 * 액션 실행 후 선택적으로 페이지 상태를 캡처합니다.
 * includeSnapshot 옵션이 없거나 모두 false면 undefined를 반환합니다.
 */
export async function capturePostActionSnapshot(
  pool: ConnectionPool,
  options?: SnapshotOptions
): Promise<PostActionSnapshot | undefined> {
  if (!options || (!options.screenshot && !options.pageInfo)) {
    return undefined;
  }

  const result: PostActionSnapshot = {};

  const promises: Promise<void>[] = [];

  if (options.screenshot) {
    promises.push(
      screenshot(pool, { format: 'png' }).then(s => { result.screenshot = s; })
    );
  }

  if (options.pageInfo) {
    promises.push(
      getPageInfo(pool).then(p => { result.pageInfo = p; })
    );
  }

  await Promise.all(promises);

  return result;
}
