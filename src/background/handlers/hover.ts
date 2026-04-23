import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface TargetSpec {
  type: 'coordinates' | 'css' | 'xpath';
  value: string | { x: number; y: number };
}

async function resolveCoordinates(tabId: number, target: TargetSpec): Promise<{ x: number; y: number }> {
  if (target.type === 'coordinates') {
    return target.value as { x: number; y: number };
  }

  await debuggerManager.enableDomain(tabId, 'Runtime');
  const selector = target.value as string;
  const script = target.type === 'css'
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`
    : `(() => { const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue; if (!el || !(el instanceof Element)) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;

  const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
    expression: script, returnByValue: true,
  })) as { result: { value: { x: number; y: number } | null } };

  if (!result.result.value) throw new Error(`Element not found: ${selector}`);
  return result.result.value;
}

function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, delay));
}

export function registerHoverHandlers(): void {
  registerHandler('hover_element', async (params, tabId) => {
    const { target } = params as { target: TargetSpec };
    await debuggerManager.ensureAttached(tabId);

    const { x, y } = await resolveCoordinates(tabId, target);

    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });

    // Randomized dwell time for human-like behavior
    await randomDelay(50, 150);

    return { x, y };
  });
}
