import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isSessionInfoTab,
  generateSessionInfoHtml,
  buildDataUrl,
  generateUpdateScript,
  SessionInfoTabManager,
} from '../session-info-tab.js';
import type { SessionInfoData } from '../session-info-tab.js';
import type { TargetInfoCdp } from '../../cdp/protocol-types.js';

function makeSessionData(overrides: Partial<SessionInfoData> = {}): SessionInfoData {
  return {
    port: 9222,
    sessionId: 'cdp-mcp_9222_1700000000000',
    sessionName: 'cdp-mcp-9222',
    mcpPid: 12345,
    ownerPid: 11111,
    chromePid: 22222,
    startedAt: 1700000000000,
    status: 'CONNECTED',
    ...overrides,
  };
}

function makeTarget(overrides: Partial<TargetInfoCdp> = {}): TargetInfoCdp {
  return {
    targetId: 'target-1',
    type: 'page',
    title: 'Test Page',
    url: 'https://example.com',
    attached: false,
    ...overrides,
  };
}

function createMockPool() {
  const mockBrowserSend = vi.fn();
  const mockSessionSend = vi.fn();
  const mockSession = { send: mockSessionSend, connected: true, close: vi.fn() };

  return {
    getBrowserClient: vi.fn().mockReturnValue({ send: mockBrowserSend, connected: true }),
    getConnection: vi.fn().mockResolvedValue(mockSession),
    releaseConnection: vi.fn(),
    mockBrowserSend,
    mockSessionSend,
    mockSession,
  };
}

describe('isSessionInfoTab()', () => {
  it('returns true for data URL with session info marker fragment', () => {
    expect(isSessionInfoTab('data:text/html;charset=utf-8,...#cdp-mcp-session-info')).toBe(true);
  });

  it('returns true for URL containing the marker anywhere', () => {
    expect(isSessionInfoTab('https://example.com#cdp-mcp-session-info')).toBe(true);
  });

  it('returns false for regular URLs', () => {
    expect(isSessionInfoTab('https://example.com')).toBe(false);
  });

  it('returns false for about:blank', () => {
    expect(isSessionInfoTab('about:blank')).toBe(false);
  });

  it('returns false for chrome:// URLs', () => {
    expect(isSessionInfoTab('chrome://newtab')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isSessionInfoTab('')).toBe(false);
  });
});

describe('generateSessionInfoHtml()', () => {
  it('returns HTML string containing session data', () => {
    const data = makeSessionData();
    const html = generateSessionInfoHtml(data);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('CDP-MCP Session');
    expect(html).toContain('9222');
    expect(html).toContain('cdp-mcp_9222_1700000000000');
    expect(html).toContain('cdp-mcp-9222');
    expect(html).toContain('12345');
    expect(html).toContain('11111');
    expect(html).toContain('22222');
    expect(html).toContain('CONNECTED');
  });

  it('shows dash for missing ownerPid', () => {
    const data = makeSessionData({ ownerPid: undefined });
    const html = generateSessionInfoHtml(data);

    expect(html).toContain('id="v-ownerPid">-</td>');
  });

  it('shows dash for missing chromePid', () => {
    const data = makeSessionData({ chromePid: undefined });
    const html = generateSessionInfoHtml(data);

    expect(html).toContain('id="v-chromePid">-</td>');
  });

  it('uses reconnected status class when RECONNECTED', () => {
    const data = makeSessionData({ status: 'RECONNECTED' });
    const html = generateSessionInfoHtml(data);

    expect(html).toContain('class="status reconnected"');
    expect(html).toContain('RECONNECTED');
  });
});

describe('buildDataUrl()', () => {
  it('creates a data: URL with html content and fragment', () => {
    const url = buildDataUrl('<html>test</html>');

    expect(url).toMatch(/^data:text\/html;charset=utf-8,/);
    expect(url).toContain('#cdp-mcp-session-info');
  });

  it('encodes HTML content', () => {
    const url = buildDataUrl('<html><body>Hello World</body></html>');

    expect(url).not.toContain('<html>');
    expect(decodeURIComponent(url.split('#')[0].replace('data:text/html;charset=utf-8,', '')))
      .toBe('<html><body>Hello World</body></html>');
  });

  it('produces URL that isSessionInfoTab recognizes', () => {
    const url = buildDataUrl('<html>test</html>');
    expect(isSessionInfoTab(url)).toBe(true);
  });
});

describe('generateUpdateScript()', () => {
  it('returns a JavaScript string', () => {
    const data = makeSessionData();
    const script = generateUpdateScript(data);

    expect(script).toContain('document.getElementById');
    expect(script).toContain("return 'updated'");
  });

  it('includes all session data fields', () => {
    const data = makeSessionData();
    const script = generateUpdateScript(data);

    expect(script).toContain('9222');
    expect(script).toContain('cdp-mcp_9222_1700000000000');
    expect(script).toContain('cdp-mcp-9222');
    expect(script).toContain('12345');
    expect(script).toContain('11111');
    expect(script).toContain('22222');
    expect(script).toContain('CONNECTED');
  });

  it('updates status class name', () => {
    const data = makeSessionData({ status: 'RECONNECTED' });
    const script = generateUpdateScript(data);

    expect(script).toContain("'reconnected'");
  });
});

describe('SessionInfoTabManager', () => {
  let pool: ReturnType<typeof createMockPool>;
  let manager: SessionInfoTabManager;

  beforeEach(() => {
    pool = createMockPool();
    manager = new SessionInfoTabManager(pool as any);
  });

  describe('ensureSessionInfoTab()', () => {
    it('updates existing session info tab via Runtime.evaluate', async () => {
      const sessionInfoTarget = makeTarget({
        targetId: 'session-tab',
        url: 'data:text/html;charset=utf-8,...#cdp-mcp-session-info',
      });

      pool.mockBrowserSend.mockResolvedValue({
        targetInfos: [sessionInfoTarget],
      });

      await manager.ensureSessionInfoTab(makeSessionData());

      expect(pool.getConnection).toHaveBeenCalledWith('session-tab');
      expect(pool.mockSessionSend).toHaveBeenCalledWith(
        'Runtime.evaluate',
        expect.objectContaining({ returnByValue: true }),
      );
    });

    it('navigates blank tab when it is the only tab', async () => {
      const blankTarget = makeTarget({
        targetId: 'blank-tab',
        url: 'about:blank',
      });

      pool.mockBrowserSend.mockResolvedValue({
        targetInfos: [blankTarget],
      });

      await manager.ensureSessionInfoTab(makeSessionData());

      expect(pool.getConnection).toHaveBeenCalledWith('blank-tab');
      expect(pool.mockSessionSend).toHaveBeenCalledWith(
        'Page.navigate',
        expect.objectContaining({
          url: expect.stringContaining('cdp-mcp-session-info'),
        }),
      );
    });

    it('navigates chrome://newtab/ tab when it is the only tab', async () => {
      const newTabTarget = makeTarget({
        targetId: 'newtab',
        url: 'chrome://newtab/',
      });

      pool.mockBrowserSend.mockResolvedValue({
        targetInfos: [newTabTarget],
      });

      await manager.ensureSessionInfoTab(makeSessionData());

      expect(pool.getConnection).toHaveBeenCalledWith('newtab');
      expect(pool.mockSessionSend).toHaveBeenCalledWith(
        'Page.navigate',
        expect.objectContaining({
          url: expect.stringContaining('cdp-mcp-session-info'),
        }),
      );
    });

    it('creates new tab when multiple tabs exist and none is session info', async () => {
      const userTab = makeTarget({ targetId: 'user-tab', url: 'https://example.com' });
      const blankTab = makeTarget({ targetId: 'blank-tab', url: 'about:blank' });

      pool.mockBrowserSend
        .mockResolvedValueOnce({ targetInfos: [userTab, blankTab] }) // Target.getTargets
        .mockResolvedValueOnce({ targetId: 'new-session-tab' }); // Target.createTarget

      await manager.ensureSessionInfoTab(makeSessionData());

      expect(pool.mockBrowserSend).toHaveBeenCalledWith(
        'Target.createTarget',
        expect.objectContaining({
          url: expect.stringContaining('cdp-mcp-session-info'),
        }),
      );
    });

    it('creates new tab when no tabs exist', async () => {
      pool.mockBrowserSend
        .mockResolvedValueOnce({ targetInfos: [] }) // Target.getTargets
        .mockResolvedValueOnce({ targetId: 'new-tab' }); // Target.createTarget

      await manager.ensureSessionInfoTab(makeSessionData());

      expect(pool.mockBrowserSend).toHaveBeenCalledWith(
        'Target.createTarget',
        expect.objectContaining({
          url: expect.stringContaining('cdp-mcp-session-info'),
        }),
      );
    });

    it('closes and recreates tab when update fails', async () => {
      const sessionInfoTarget = makeTarget({
        targetId: 'session-tab',
        url: 'data:text/html;charset=utf-8,...#cdp-mcp-session-info',
      });

      pool.mockBrowserSend
        .mockResolvedValueOnce({ targetInfos: [sessionInfoTarget] }) // Target.getTargets
        .mockResolvedValueOnce(undefined) // Target.closeTarget
        .mockResolvedValueOnce({ targetId: 'new-session-tab' }); // Target.createTarget

      // Make Runtime.evaluate fail
      pool.mockSessionSend.mockRejectedValueOnce(new Error('evaluate failed'));

      await manager.ensureSessionInfoTab(makeSessionData());

      // Should have tried to close the old tab
      expect(pool.mockBrowserSend).toHaveBeenCalledWith(
        'Target.closeTarget',
        { targetId: 'session-tab' },
      );
      // Should have created a new tab
      expect(pool.mockBrowserSend).toHaveBeenCalledWith(
        'Target.createTarget',
        expect.objectContaining({
          url: expect.stringContaining('cdp-mcp-session-info'),
        }),
      );
    });

    it('falls back to new tab when blank tab navigation fails', async () => {
      const blankTarget = makeTarget({
        targetId: 'blank-tab',
        url: 'about:blank',
      });

      pool.mockBrowserSend
        .mockResolvedValueOnce({ targetInfos: [blankTarget] }) // Target.getTargets
        .mockResolvedValueOnce({ targetId: 'new-tab' }); // Target.createTarget

      // Make Page.navigate fail
      pool.mockSessionSend.mockRejectedValueOnce(new Error('navigate failed'));

      await manager.ensureSessionInfoTab(makeSessionData());

      expect(pool.mockBrowserSend).toHaveBeenCalledWith(
        'Target.createTarget',
        expect.objectContaining({
          url: expect.stringContaining('cdp-mcp-session-info'),
        }),
      );
    });
  });
});
