import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface TargetSpec {
  type: 'coordinates' | 'css' | 'xpath';
  value: string | { x: number; y: number };
}

async function resolveCoordinates(tabId: number, target: TargetSpec): Promise<{ x: number; y: number }> {
  if (target.type === 'coordinates') {
    const coords = target.value as { x: number; y: number };
    return coords;
  }

  // Use Runtime.evaluate to find element and get its center
  await debuggerManager.enableDomain(tabId, 'Runtime');
  const selector = target.value as string;
  const findScript = target.type === 'css'
    ? `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`
    : `(() => {
        const result = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const el = result.singleNodeValue;
        if (!el || !(el instanceof Element)) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      })()`;

  const evalResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
    expression: findScript,
    returnByValue: true,
  })) as { result: { value: { x: number; y: number } | null } };

  if (!evalResult.result.value) {
    throw new Error(`Element not found: ${selector}`);
  }

  return evalResult.result.value;
}

function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, delay));
}

function bezierCurve(
  p0: { x: number; y: number },
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  steps: number
): Array<{ x: number; y: number }> {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x;
    const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

async function getCurrentMousePosition(tabId: number): Promise<{ x: number; y: number }> {
  try {
    const script = `(() => {
      // We can't actually read mouse position, so return center of viewport as fallback
      return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    })()`;
    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: { x: number; y: number } } };
    return result.result.value;
  } catch {
    return { x: 0, y: 0 };
  }
}

const BUTTON_MAP: Record<string, number> = { left: 0, middle: 1, right: 2 };

export function registerClickHandlers(): void {
  registerHandler('click_element', async (params, tabId) => {
    const { target, button = 'left', doubleClick = false } = params as {
      target: TargetSpec;
      button?: 'left' | 'right' | 'middle';
      doubleClick?: boolean;
    };

    await debuggerManager.ensureAttached(tabId);
    const { x, y } = await resolveCoordinates(tabId, target);
    const buttonNum = BUTTON_MAP[button] ?? 0;

    // Get starting position for Bézier curve
    const startPos = await getCurrentMousePosition(tabId);

    // Generate a control point for a slight curve
    const midX = (startPos.x + x) / 2 + (Math.random() * 40 - 20);
    const midY = (startPos.y + y) / 2 + (Math.random() * 40 - 20);
    const curve = bezierCurve(startPos, { x: midX, y: midY }, { x, y }, 8);

    // Move along Bézier curve
    for (const point of curve) {
      await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved', x: point.x, y: point.y,
      });
      await randomDelay(5, 15);
    }

    // Randomized delay before mousedown
    await randomDelay(20, 80);

    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: button === 'middle' ? 'middle' : button === 'right' ? 'right' : 'left',
      clickCount: 1,
    });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: button === 'middle' ? 'middle' : button === 'right' ? 'right' : 'left',
      clickCount: 1,
    });

    if (doubleClick) {
      await randomDelay(40, 100);
      await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mousePressed', x, y, button: 'left', clickCount: 2,
      });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased', x, y, button: 'left', clickCount: 2,
      });
    }

    return { x, y, button, doubleClick };
  });
}
