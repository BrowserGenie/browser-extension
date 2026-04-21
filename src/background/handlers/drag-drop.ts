import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface PositionSpec {
  type: 'coordinates' | 'css' | 'xpath';
  value: string | { x: number; y: number };
}

async function resolvePosition(tabId: number, pos: PositionSpec): Promise<{ x: number; y: number }> {
  if (pos.type === 'coordinates') {
    return pos.value as { x: number; y: number };
  }

  await debuggerManager.enableDomain(tabId, 'Runtime');
  const selector = pos.value as string;
  const script = pos.type === 'css'
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`
    : `(() => { const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue; if (!el || !(el instanceof Element)) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;

  const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
    expression: script, returnByValue: true,
  })) as { result: { value: { x: number; y: number } | null } };

  if (!result.result.value) throw new Error(`Element not found: ${selector}`);
  return result.result.value;
}

export function registerDragDropHandlers(): void {
  registerHandler('drag_and_drop', async (params, tabId) => {
    const { from, to } = params as { from: PositionSpec; to: PositionSpec };
    await debuggerManager.ensureAttached(tabId);

    const fromPos = await resolvePosition(tabId, from);
    const toPos = await resolvePosition(tabId, to);

    const steps = 10;
    const dx = (toPos.x - fromPos.x) / steps;
    const dy = (toPos.y - fromPos.y) / steps;

    // Move to start, then press
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: fromPos.x, y: fromPos.y, button: 'none', buttons: 0,
    });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: fromPos.x, y: fromPos.y, button: 'left', buttons: 1, clickCount: 1,
    });

    // Drag in steps — buttons:1 tells the browser the left button is held during movement
    for (let i = 1; i <= steps; i++) {
      await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: Math.round(fromPos.x + dx * i),
        y: Math.round(fromPos.y + dy * i),
        button: 'left',
        buttons: 1,
      });
      await new Promise((r) => setTimeout(r, 20));
    }

    // Release at target
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: toPos.x, y: toPos.y, button: 'left', buttons: 0, clickCount: 1,
    });

    return { from: fromPos, to: toPos };
  });
}
