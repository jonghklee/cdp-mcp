import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LazyConnectionManager } from '../server.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('idb-tools');

const EXT_PARAM = z.string().optional().describe(
  '익스텐션 이름 또는 ID. 이름은 부분 일치 (예: "ChatLens"). 생략 시 마지막 사용한 익스텐션'
);

/**
 * Service Worker에서 IndexedDB 코드를 실행하고 결과 반환.
 * awaitPromise=true로 비동기 코드 지원.
 */
async function evalInWorker(
  lazy: LazyConnectionManager,
  extensionId: string,
  expression: string
): Promise<unknown> {
  const { extensionManager } = await lazy.ensure();
  const session = await extensionManager.attachToWorker(extensionId);
  const result = await session.send<{
    result: { type: string; value?: unknown };
    exceptionDetails?: { text: string; exception?: { description?: string } };
  }>('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });

  if (result.exceptionDetails) {
    const errMsg =
      result.exceptionDetails.exception?.description ??
      result.exceptionDetails.text ??
      'Unknown error';
    throw new Error(errMsg);
  }

  return result.result.value;
}

export function registerIdbTools(
  server: McpServer,
  lazy: LazyConnectionManager
): void {
  // cdp_ext_idb — IndexedDB 범용 접근
  server.tool(
    'cdp_ext_idb',
    `익스텐션의 IndexedDB(Dexie 포함)에 직접 접근합니다.
Service Worker context에서 raw IndexedDB API로 데이터를 조회/수정합니다.

action 종류:
- list_databases: 모든 IndexedDB 데이터베이스 목록
- list_stores: 특정 DB의 object store 목록 + 인덱스 정보
- query: store에서 레코드 조회 (전체, key, index 필터, limit/offset)
- count: store의 레코드 수
- get: 단일 레코드 조회 (key 지정)
- put: 레코드 추가/수정 (key 기반 upsert)
- delete: 레코드 삭제 (key 지정)
- clear: store 전체 비우기 (주의!)

Dexie 호환:
- Dexie가 만든 DB도 동일한 IndexedDB이므로 그대로 접근 가능
- Dexie의 테이블 이름 = IndexedDB object store 이름`,
    {
      extension: EXT_PARAM,
      action: z.enum([
        'list_databases',
        'list_stores',
        'query',
        'count',
        'get',
        'put',
        'delete',
        'clear',
      ]).describe('수행할 작업'),
      dbName: z.string().optional().describe('IndexedDB 이름 (list_databases 제외 필수)'),
      storeName: z.string().optional().describe('Object store 이름 (query/count/get/put/delete/clear 시 필수)'),
      key: z.unknown().optional().describe('레코드 키 (get/put/delete 시 사용)'),
      value: z.record(z.string(), z.unknown()).optional().describe('저장할 데이터 (put 시 필수)'),
      indexName: z.string().optional().describe('인덱스 이름 (query 시 인덱스 기반 필터)'),
      indexValue: z.unknown().optional().describe('인덱스 값 (indexName과 함께 사용)'),
      limit: z.number().optional().describe('최대 결과 수 (query 시, 기본 100)'),
      offset: z.number().optional().describe('건너뛸 레코드 수 (query 시, 기본 0)'),
    },
    async ({ extension, action, dbName, storeName, key, value, indexName, indexValue, limit, offset }) => {
      try {
        const { extensionManager } = await lazy.ensure();
        const ext = await extensionManager.resolveExtension(extension);
        const extensionId = ext.id;

        let result: unknown;

        switch (action) {
          case 'list_databases': {
            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                const dbs = await indexedDB.databases();
                return dbs.map(db => ({ name: db.name, version: db.version }));
              })()`
            );
            break;
          }

          case 'list_stores': {
            if (!dbName) throw new Error('dbName is required for list_stores');
            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                return new Promise((resolve, reject) => {
                  const req = indexedDB.open(${JSON.stringify(dbName)});
                  req.onerror = () => reject(new Error('Failed to open DB: ' + req.error?.message));
                  req.onsuccess = () => {
                    const db = req.result;
                    const stores = [];
                    for (const name of db.objectStoreNames) {
                      const tx = db.transaction(name, 'readonly');
                      const store = tx.objectStore(name);
                      const indexes = [];
                      for (const idxName of store.indexNames) {
                        const idx = store.index(idxName);
                        indexes.push({ name: idx.name, keyPath: idx.keyPath, unique: idx.unique, multiEntry: idx.multiEntry });
                      }
                      stores.push({ name, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes });
                    }
                    db.close();
                    resolve(stores);
                  };
                });
              })()`
            );
            break;
          }

          case 'query': {
            if (!dbName) throw new Error('dbName is required for query');
            if (!storeName) throw new Error('storeName is required for query');
            const lim = limit ?? 100;
            const off = offset ?? 0;
            const useIndex = indexName && indexValue !== undefined;

            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                return new Promise((resolve, reject) => {
                  const req = indexedDB.open(${JSON.stringify(dbName)});
                  req.onerror = () => reject(new Error('Failed to open DB'));
                  req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction(${JSON.stringify(storeName)}, 'readonly');
                    const store = tx.objectStore(${JSON.stringify(storeName)});
                    ${useIndex
                      ? `const source = store.index(${JSON.stringify(indexName)});
                         const cursorReq = source.openCursor(IDBKeyRange.only(${JSON.stringify(indexValue)}));`
                      : `const cursorReq = store.openCursor();`
                    }
                    const results = [];
                    let skipped = 0;
                    cursorReq.onsuccess = () => {
                      const cursor = cursorReq.result;
                      if (!cursor || results.length >= ${lim}) {
                        db.close();
                        resolve({ records: results, total: results.length, offset: ${off}, limit: ${lim} });
                        return;
                      }
                      if (skipped < ${off}) {
                        skipped++;
                        cursor.continue();
                        return;
                      }
                      results.push({ key: cursor.key, primaryKey: cursor.primaryKey, value: cursor.value });
                      cursor.continue();
                    };
                    cursorReq.onerror = () => { db.close(); reject(new Error('Cursor error')); };
                  };
                });
              })()`
            );
            break;
          }

          case 'count': {
            if (!dbName) throw new Error('dbName is required for count');
            if (!storeName) throw new Error('storeName is required for count');
            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                return new Promise((resolve, reject) => {
                  const req = indexedDB.open(${JSON.stringify(dbName)});
                  req.onerror = () => reject(new Error('Failed to open DB'));
                  req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction(${JSON.stringify(storeName)}, 'readonly');
                    const countReq = tx.objectStore(${JSON.stringify(storeName)}).count();
                    countReq.onsuccess = () => { db.close(); resolve({ count: countReq.result }); };
                    countReq.onerror = () => { db.close(); reject(new Error('Count error')); };
                  };
                });
              })()`
            );
            break;
          }

          case 'get': {
            if (!dbName) throw new Error('dbName is required for get');
            if (!storeName) throw new Error('storeName is required for get');
            if (key === undefined) throw new Error('key is required for get');
            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                return new Promise((resolve, reject) => {
                  const req = indexedDB.open(${JSON.stringify(dbName)});
                  req.onerror = () => reject(new Error('Failed to open DB'));
                  req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction(${JSON.stringify(storeName)}, 'readonly');
                    const getReq = tx.objectStore(${JSON.stringify(storeName)}).get(${JSON.stringify(key)});
                    getReq.onsuccess = () => { db.close(); resolve({ value: getReq.result ?? null }); };
                    getReq.onerror = () => { db.close(); reject(new Error('Get error')); };
                  };
                });
              })()`
            );
            break;
          }

          case 'put': {
            if (!dbName) throw new Error('dbName is required for put');
            if (!storeName) throw new Error('storeName is required for put');
            if (!value) throw new Error('value is required for put');
            const putArgs = key !== undefined
              ? `${JSON.stringify(value)}, ${JSON.stringify(key)}`
              : JSON.stringify(value);
            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                return new Promise((resolve, reject) => {
                  const req = indexedDB.open(${JSON.stringify(dbName)});
                  req.onerror = () => reject(new Error('Failed to open DB'));
                  req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction(${JSON.stringify(storeName)}, 'readwrite');
                    const putReq = tx.objectStore(${JSON.stringify(storeName)}).put(${putArgs});
                    putReq.onsuccess = () => { db.close(); resolve({ success: true, key: putReq.result }); };
                    putReq.onerror = () => { db.close(); reject(new Error('Put error: ' + putReq.error?.message)); };
                  };
                });
              })()`
            );
            break;
          }

          case 'delete': {
            if (!dbName) throw new Error('dbName is required for delete');
            if (!storeName) throw new Error('storeName is required for delete');
            if (key === undefined) throw new Error('key is required for delete');
            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                return new Promise((resolve, reject) => {
                  const req = indexedDB.open(${JSON.stringify(dbName)});
                  req.onerror = () => reject(new Error('Failed to open DB'));
                  req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction(${JSON.stringify(storeName)}, 'readwrite');
                    const delReq = tx.objectStore(${JSON.stringify(storeName)}).delete(${JSON.stringify(key)});
                    delReq.onsuccess = () => { db.close(); resolve({ success: true }); };
                    delReq.onerror = () => { db.close(); reject(new Error('Delete error')); };
                  };
                });
              })()`
            );
            break;
          }

          case 'clear': {
            if (!dbName) throw new Error('dbName is required for clear');
            if (!storeName) throw new Error('storeName is required for clear');
            result = await evalInWorker(
              lazy,
              extensionId,
              `(async () => {
                return new Promise((resolve, reject) => {
                  const req = indexedDB.open(${JSON.stringify(dbName)});
                  req.onerror = () => reject(new Error('Failed to open DB'));
                  req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction(${JSON.stringify(storeName)}, 'readwrite');
                    const clearReq = tx.objectStore(${JSON.stringify(storeName)}).clear();
                    clearReq.onsuccess = () => { db.close(); resolve({ success: true }); };
                    clearReq.onerror = () => { db.close(); reject(new Error('Clear error')); };
                  };
                });
              })()`
            );
            break;
          }
        }

        logger.info(`IDB ${action} on ${ext.name}(${extensionId})${dbName ? '/' + dbName : ''}${storeName ? '/' + storeName : ''}`);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ action, extension: { id: ext.id, name: ext.name }, result }),
          }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({ error: message }),
          }],
          isError: true,
        };
      }
    }
  );
}
