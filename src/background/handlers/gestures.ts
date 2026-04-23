import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface TouchPoint {
  x: number;
  y: number;
  id: number;
}

function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, delay));
}

async function dispatchTouchEvent(
  tabId: number,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  points: TouchPoint[]
): Promise<void> {
  const touchPoints = points.map((p) => ({
    x: Math.round(p.x),
    y: Math.round(p.y),
    id: p.id,
    force: 0.5 + Math.random() * 0.3,
    radiusX: 10 + Math.random() * 5,
    radiusY: 10 + Math.random() * 5,
    rotationAngle: Math.random() * 360,
  }));

  await debuggerManager.sendCommand(tabId, 'Input.dispatchTouchEvent', {
    type,
    touchPoints,
  });
}

export function registerGestureHandlers(): void {
  registerHandler('double_tap', async (params, tabId) => {
    const { target, interval = 80 } = params as {
      target: { type: 'coordinates' | 'css' | 'xpath'; value: string | { x: number; y: number } };
      interval?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    let x: number, y: number;
    if (target.type === 'coordinates') {
      ({ x, y } = target.value as { x: number; y: number });
    } else {
      const selector = target.value as string;
      const script = target.type === 'css'
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`
        : `(() => { const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue; if (!el || !(el instanceof Element)) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;
      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script, returnByValue: true,
      })) as { result: { value: { x: number; y: number } | null } };
      if (!result.result.value) throw new Error(`Element not found: ${selector}`);
      ({ x, y } = result.result.value);
    }

    const touchId = Date.now() % 10000;
    // First tap
    await dispatchTouchEvent(tabId, 'touchStart', [{ x, y, id: touchId }]);
    await randomDelay(20, 40);
    await dispatchTouchEvent(tabId, 'touchEnd', [{ x, y, id: touchId }]);
    // Short interval between taps
    await new Promise((r) => setTimeout(r, interval));
    // Second tap
    await dispatchTouchEvent(tabId, 'touchStart', [{ x, y, id: touchId + 1 }]);
    await randomDelay(20, 40);
    await dispatchTouchEvent(tabId, 'touchEnd', [{ x, y, id: touchId + 1 }]);

    return { x, y, interval, taps: 2 };
  });

  registerHandler('swipe', async (params, tabId) => {
    const { from, to, duration = 500 } = params as {
      from: { x: number; y: number };
      to: { x: number; y: number };
      duration?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    const steps = Math.max(10, Math.floor(duration / 16));
    const startId = Date.now() % 10000;

    // Touch start
    await dispatchTouchEvent(tabId, 'touchStart', [{ x: from.x, y: from.y, id: startId }]);
    await randomDelay(20, 40);

    // Touch move with interpolation
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t;
      const y = from.y + (to.y - from.y) * t;
      await dispatchTouchEvent(tabId, 'touchMove', [{ x, y, id: startId }]);
      await new Promise((r) => setTimeout(r, duration / steps));
    }

    // Touch end
    await dispatchTouchEvent(tabId, 'touchEnd', [{ x: to.x, y: to.y, id: startId }]);
    await randomDelay(20, 40);

    return { from, to, duration, steps };
  });

  registerHandler('long_press', async (params, tabId) => {
    const { target, duration = 800 } = params as {
      target: { type: 'coordinates' | 'css' | 'xpath'; value: string | { x: number; y: number } };
      duration?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    let x: number, y: number;
    if (target.type === 'coordinates') {
      ({ x, y } = target.value as { x: number; y: number });
    } else {
      const selector = target.value as string;
      const script = target.type === 'css'
        ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`
        : `(() => { const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue; if (!el || !(el instanceof Element)) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`;
      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script, returnByValue: true,
      })) as { result: { value: { x: number; y: number } | null } };
      if (!result.result.value) throw new Error(`Element not found: ${selector}`);
      ({ x, y } = result.result.value);
    }

    const touchId = Date.now() % 10000;
    await dispatchTouchEvent(tabId, 'touchStart', [{ x, y, id: touchId }]);
    await new Promise((r) => setTimeout(r, duration));
    await dispatchTouchEvent(tabId, 'touchEnd', [{ x, y, id: touchId }]);

    return { x, y, duration };
  });

  registerHandler('pinch', async (params, tabId) => {
    const { center, startRadius = 100, endRadius = 50, duration = 500 } = params as {
      center: { x: number; y: number };
      startRadius?: number;
      endRadius?: number;
      duration?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    const steps = Math.max(10, Math.floor(duration / 16));
    const id1 = Date.now() % 10000;
    const id2 = (Date.now() + 1) % 10000;

    // Calculate initial positions (horizontal spread)
    const p1Start = { x: center.x - startRadius, y: center.y };
    const p2Start = { x: center.x + startRadius, y: center.y };
    const p1End = { x: center.x - endRadius, y: center.y };
    const p2End = { x: center.x + endRadius, y: center.y };

    // Touch start both fingers
    await dispatchTouchEvent(tabId, 'touchStart', [
      { x: p1Start.x, y: p1Start.y, id: id1 },
      { x: p2Start.x, y: p2Start.y, id: id2 },
    ]);
    await randomDelay(20, 40);

    // Move both fingers
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x1 = p1Start.x + (p1End.x - p1Start.x) * t;
      const y1 = p1Start.y + (p1End.y - p1Start.y) * t;
      const x2 = p2Start.x + (p2End.x - p2Start.x) * t;
      const y2 = p2Start.y + (p2End.y - p2Start.y) * t;
      await dispatchTouchEvent(tabId, 'touchMove', [
        { x: x1, y: y1, id: id1 },
        { x: x2, y: y2, id: id2 },
      ]);
      await new Promise((r) => setTimeout(r, duration / steps));
    }

    // Release both fingers
    await dispatchTouchEvent(tabId, 'touchEnd', [
      { x: p1End.x, y: p1End.y, id: id1 },
      { x: p2End.x, y: p2End.y, id: id2 },
    ]);
    await randomDelay(20, 40);

    return { center, startRadius, endRadius, duration, steps };
  });
}
