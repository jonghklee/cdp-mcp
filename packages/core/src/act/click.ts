import type { ConnectionPool } from '../cdp/connection-pool.js';
import { createLogger, sleep } from '@cdp-mcp/shared';

const logger = createLogger('click');

export interface ClickOptions {
  selector: string;
  button?: 'left' | 'right' | 'middle';
  clickCount?: number;
  delay?: number;
  timeout?: number;
}

export interface ClickResult {
  clicked: boolean;
  selector: string;
  position: { x: number; y: number };
}

interface ElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
}

export async function click(
  pool: ConnectionPool,
  options: ClickOptions
): Promise<ClickResult> {
  const {
    selector,
    button = 'left',
    clickCount = 1,
    delay = 0,
  } = options;

  const client = await pool.getActiveTab();

  // Get element bounds and visibility
  const boundsResult = await client.send<{ result: { value: ElementBounds | null } }>('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        visible: style.visibility !== 'hidden' && style.display !== 'none' && parseFloat(style.opacity) > 0
      };
    })()`,
    returnByValue: true,
    awaitPromise: false,
  });

  const bounds = boundsResult.result.value;

  if (!bounds) {
    throw new Error(`Element not found: ${selector}`);
  }

  if (!bounds.visible) {
    throw new Error(`Element not visible: ${selector}`);
  }

  // Calculate click position (center of element)
  const x = Math.round(bounds.x + bounds.width / 2);
  const y = Math.round(bounds.y + bounds.height / 2);

  // Mouse button mapping
  const buttonMap: Record<string, string> = {
    left: 'left',
    right: 'right',
    middle: 'middle',
  };

  // Dispatch mouse events: mouseMoved → mousePressed → mouseReleased
  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  });

  await client.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: buttonMap[button],
    clickCount,
  });

  if (delay > 0) {
    await sleep(delay);
  }

  await client.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: buttonMap[button],
    clickCount,
  });

  logger.info(`Clicked '${selector}' at (${x}, ${y})`);

  return {
    clicked: true,
    selector,
    position: { x, y },
  };
}
