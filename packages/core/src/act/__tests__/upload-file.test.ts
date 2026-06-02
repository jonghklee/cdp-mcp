import { describe, it, expect, beforeEach, vi } from 'vitest';
import { uploadFile } from '../upload-file.js';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  statSync: vi.fn().mockReturnValue({ size: 1024 }),
  readFileSync: vi.fn().mockReturnValue(Buffer.from('fake-file-data')),
}));

function createMockClient() {
  return {
    send: vi.fn().mockResolvedValue({ result: { value: null } }),
    connected: true,
  };
}

function createMockPool(mockClient: ReturnType<typeof createMockClient>) {
  return {
    getActiveTab: vi.fn().mockResolvedValue(mockClient),
  };
}

describe('uploadFile', () => {
  let mockClient: ReturnType<typeof createMockClient>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = createMockClient();
    mockPool = createMockPool(mockClient);

    // Default: existsSync returns true
    (fs.existsSync as any).mockReturnValue(true);
    (fs.statSync as any).mockReturnValue({ size: 1024 });
    (fs.readFileSync as any).mockReturnValue(Buffer.from('fake-file-data'));
  });

  it('throws when file does not exist', async () => {
    (fs.existsSync as any).mockReturnValue(false);

    await expect(
      uploadFile(mockPool as any, { selector: '#upload', filePath: '/nonexistent.txt' })
    ).rejects.toThrow('File not found');
  });

  describe('auto detection', () => {
    it('uses input method for file input', async () => {
      // getElementInfo returns file input
      mockClient.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expr = (params as any)?.expression ?? '';
          if (expr.includes('tagName')) {
            return { result: { value: { tagName: 'INPUT', type: 'file', isContentEditable: false } } };
          }
          return { result: { value: true } };
        }
        if (method === 'DOM.getDocument') {
          return { root: { nodeId: 1 } };
        }
        if (method === 'DOM.querySelector') {
          return { nodeId: 2 };
        }
        return undefined;
      });

      const result = await uploadFile(mockPool as any, {
        selector: 'input[type=file]',
        filePath: '/test/photo.png',
      });

      expect(result.method).toBe('input');
      expect(result.uploaded).toBe(true);
      expect(mockClient.send).toHaveBeenCalledWith('DOM.setFileInputFiles', expect.objectContaining({
        nodeId: 2,
        files: [path.resolve('/test/photo.png')],
      }));
    });

    it('uses paste method for textarea', async () => {
      mockClient.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expr = (params as any)?.expression ?? '';
          if (expr.includes('tagName')) {
            return { result: { value: { tagName: 'TEXTAREA', type: null, isContentEditable: false } } };
          }
          return { result: { value: true } };
        }
        return undefined;
      });

      const result = await uploadFile(mockPool as any, {
        selector: 'textarea',
        filePath: '/test/data.txt',
      });

      expect(result.method).toBe('paste');

      // Check that ClipboardEvent was used
      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasPaste = evalCalls.some(c => (c[1] as any)?.expression?.includes('ClipboardEvent'));
      expect(hasPaste).toBe(true);
    });

    it('uses paste method for contenteditable', async () => {
      mockClient.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expr = (params as any)?.expression ?? '';
          if (expr.includes('tagName')) {
            return { result: { value: { tagName: 'DIV', type: null, isContentEditable: true } } };
          }
          return { result: { value: true } };
        }
        return undefined;
      });

      const result = await uploadFile(mockPool as any, {
        selector: '[contenteditable]',
        filePath: '/test/doc.pdf',
      });

      expect(result.method).toBe('paste');
    });

    it('uses drop method for other elements', async () => {
      mockClient.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expr = (params as any)?.expression ?? '';
          if (expr.includes('tagName')) {
            return { result: { value: { tagName: 'DIV', type: null, isContentEditable: false } } };
          }
          return { result: { value: true } };
        }
        return undefined;
      });

      const result = await uploadFile(mockPool as any, {
        selector: '.drop-zone',
        filePath: '/test/image.png',
      });

      expect(result.method).toBe('drop');

      // Check that DragEvent was used
      const evalCalls = mockClient.send.mock.calls.filter(c => c[0] === 'Runtime.evaluate');
      const hasDrop = evalCalls.some(c => (c[1] as any)?.expression?.includes('DragEvent'));
      expect(hasDrop).toBe(true);
    });
  });

  describe('forced method', () => {
    it('uses drop method when forced', async () => {
      mockClient.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expr = (params as any)?.expression ?? '';
          if (expr.includes('tagName')) {
            return { result: { value: { tagName: 'INPUT', type: 'file', isContentEditable: false } } };
          }
          return { result: { value: true } };
        }
        return undefined;
      });

      const result = await uploadFile(mockPool as any, {
        selector: 'input[type=file]',
        filePath: '/test/image.png',
        method: 'drop',
      });

      expect(result.method).toBe('drop');
    });
  });

  describe('file metadata', () => {
    it('returns correct fileName and fileSize', async () => {
      (fs.statSync as any).mockReturnValue({ size: 2048 });

      mockClient.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expr = (params as any)?.expression ?? '';
          if (expr.includes('tagName')) {
            return { result: { value: { tagName: 'DIV', type: null, isContentEditable: false } } };
          }
          return { result: { value: true } };
        }
        return undefined;
      });

      const result = await uploadFile(mockPool as any, {
        selector: '.zone',
        filePath: '/test/document.pdf',
      });

      expect(result.fileName).toBe('document.pdf');
      expect(result.fileSize).toBe(2048);
    });

    it('uses custom fileName when provided', async () => {
      mockClient.send.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Runtime.evaluate') {
          const expr = (params as any)?.expression ?? '';
          if (expr.includes('tagName')) {
            return { result: { value: { tagName: 'DIV', type: null, isContentEditable: false } } };
          }
          return { result: { value: true } };
        }
        return undefined;
      });

      const result = await uploadFile(mockPool as any, {
        selector: '.zone',
        filePath: '/test/image.png',
        fileName: 'custom-name.png',
      });

      expect(result.fileName).toBe('custom-name.png');
    });
  });
});
