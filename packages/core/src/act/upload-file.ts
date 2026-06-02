import * as fs from 'fs';
import * as path from 'path';
import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger } from '@cdp-mcp/shared';

const logger = createLogger('upload-file');

// ── Public types ──

export type UploadMethod = 'auto' | 'input' | 'drop' | 'paste';

export interface UploadFileOptions {
  selector: string;
  filePath: string;
  method?: UploadMethod;
  mimeType?: string;
  fileName?: string;
}

export interface UploadFileResult {
  uploaded: boolean;
  method: 'input' | 'drop' | 'paste';
  selector: string;
  fileName: string;
  fileSize: number;
}

interface ElementInfo {
  tagName: string;
  type: string | null;
  isContentEditable: boolean;
}

// ── Public API ──

export async function uploadFile(
  pool: ConnectionPool,
  options: UploadFileOptions,
): Promise<UploadFileResult> {
  const { selector, filePath, method = 'auto', mimeType, fileName } = options;

  // Validate file exists
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stats = fs.statSync(filePath);
  const resolvedFileName = fileName ?? path.basename(filePath);
  const resolvedMimeType = mimeType ?? guessMimeType(filePath);

  const client = await pool.getActiveTab();

  // Detect element type for auto method
  const elementInfo = await getElementInfo(client, selector);
  const resolvedMethod = method === 'auto' ? detectMethod(elementInfo) : method;

  switch (resolvedMethod) {
    case 'input':
      await uploadViaInput(client, selector, filePath);
      break;
    case 'drop':
      await uploadViaDrop(client, selector, filePath, resolvedFileName, resolvedMimeType);
      break;
    case 'paste':
      await uploadViaPaste(client, selector, filePath, resolvedFileName, resolvedMimeType);
      break;
  }

  logger.info(`Uploaded ${resolvedFileName} (${stats.size} bytes) via ${resolvedMethod} to ${selector}`);

  return {
    uploaded: true,
    method: resolvedMethod,
    selector,
    fileName: resolvedFileName,
    fileSize: stats.size,
  };
}

// ── Method detection ──

function detectMethod(info: ElementInfo): 'input' | 'drop' | 'paste' {
  if (info.tagName === 'INPUT' && info.type === 'file') {
    return 'input';
  }
  if (info.tagName === 'TEXTAREA' || info.isContentEditable) {
    return 'paste';
  }
  return 'drop';
}

// ── Upload methods ──

async function uploadViaInput(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  selector: string,
  filePath: string,
): Promise<void> {
  // Resolve the DOM node and set files
  const nodeResult = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
      if (el.tagName !== 'INPUT' || el.type !== 'file') {
        throw new Error('Element is not a file input: ${selector.replace(/'/g, "\\'")}');
      }
      return true;
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });

  // Use DOM.querySelector to get nodeId, then set files
  const docResult = await client.send('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
  const queryResult = await client.send('DOM.querySelector', {
    nodeId: docResult.root.nodeId,
    selector,
  }) as { nodeId: number };

  if (!queryResult.nodeId) {
    throw new Error(`Element not found via DOM.querySelector: ${selector}`);
  }

  const absolutePath = path.resolve(filePath);
  await client.send('DOM.setFileInputFiles', {
    nodeId: queryResult.nodeId,
    files: [absolutePath],
  });
}

async function uploadViaDrop(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  selector: string,
  filePath: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const fileData = fs.readFileSync(filePath);
  const base64Data = fileData.toString('base64');

  await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');

      const base64 = ${JSON.stringify(base64Data)};
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });

      const dt = new DataTransfer();
      dt.items.add(file);

      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      for (const type of ['dragenter', 'dragover', 'drop']) {
        const event = new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: cx,
          clientY: cy,
        });
        el.dispatchEvent(event);
      }
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
}

async function uploadViaPaste(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  selector: string,
  filePath: string,
  fileName: string,
  mimeType: string,
): Promise<void> {
  const fileData = fs.readFileSync(filePath);
  const base64Data = fileData.toString('base64');

  await client.send('Runtime.evaluate', {
    expression: `(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
      el.focus();

      const base64 = ${JSON.stringify(base64Data)};
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], ${JSON.stringify(fileName)}, { type: ${JSON.stringify(mimeType)} });

      const dt = new DataTransfer();
      dt.items.add(file);

      const event = new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      el.dispatchEvent(event);
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
}

// ── Helpers ──

async function getElementInfo(
  client: { send: (method: string, params?: Record<string, unknown>) => Promise<unknown> },
  selector: string,
): Promise<ElementInfo> {
  const result = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ${selector.replace(/'/g, "\\'")}');
      return {
        tagName: el.tagName,
        type: el.type || null,
        isContentEditable: el.isContentEditable || false,
      };
    })()`,
    awaitPromise: true,
    returnByValue: true,
  }) as { result: { value: ElementInfo } };

  return result.result.value;
}

const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
};

function guessMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}
