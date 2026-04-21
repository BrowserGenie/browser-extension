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

    // Simulate real click: mouseMoved -> mousePressed -> mouseReleased
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: button === 'middle' ? 'middle' : button === 'right' ? 'right' : 'left',
      clickCount: 1,
    });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: button === 'middle' ? 'middle' : button === 'right' ? 'right' : 'left',
      clickCount: 1,
    });

    if (doubleClick) {
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
