import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface TargetSpec {
  type: 'coordinates' | 'css' | 'xpath';
  value: string | { x: number; y: number };
}

interface ElementInfo {
  x: number; // center x (viewport-relative, after scroll)
  y: number; // center y (viewport-relative, after scroll)
  width: number;
  height: number;
  tagName: string;
  typeAttr?: string;
  classes?: string;
  hidden: boolean; // opacity:0, display:none, or visibility:hidden
  small: boolean; // bounding box below minimum safe click size
  offScreen: boolean; // element was off-screen before scrolling
  visibleTargetX?: number; // center x of the VISIBLE click target (for hidden inputs)
  visibleTargetY?: number; // center y of the VISIBLE click target (for hidden inputs)
}

async function runtimeEvalValue<T>(tabId: number, expr: string): Promise<T | null> {
  const res = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
  })) as { result: { value: T | null } };
  return res.result.value;
}

/**
 * Resolve element position, scrolling into view first so CDP mouse events
 * can always reach it. For hidden elements (e.g. Ant Design opacity:0 checkboxes),
 * resolves the VISIBLE overlay/sibling that a real user would actually click.
 */
async function resolveElementInfo(tabId: number, target: TargetSpec): Promise<ElementInfo | null> {
  if (target.type === 'coordinates') {
    const c = target.value as { x: number; y: number };
    return {
      x: c.x, y: c.y, width: 0, height: 0,
      tagName: '', classes: '', hidden: false, small: false, offScreen: false,
    };
  }

  const selector = target.value as string;
  await debuggerManager.enableDomain(tabId, 'Runtime');

  const buildScript = (isCss: boolean) => `(() => {
    ${isCss
      ? `const el = document.querySelector(${JSON.stringify(selector)});`
      : `const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue;`}
    if (!el || !(el instanceof Element)) return null;

    // Check if element is off-screen before scrolling
    const rBefore = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const wasOffScreen = rBefore.right < 0 || rBefore.left > vw || rBefore.bottom < 0 || rBefore.top > vh;

    // Scroll into view if needed — ensures CDP mouse events can reach it
    if (typeof el.scrollIntoViewIfNeeded === 'function') {
      el.scrollIntoViewIfNeeded(true);
    } else if (wasOffScreen) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    }

    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const opacityZero = parseFloat(style.opacity || '1') === 0;
    const displayNone = style.display === 'none';
    const visHidden = style.visibility === 'hidden';
    const isHidden = opacityZero || displayNone || visHidden;

    // For hidden elements (e.g. Ant Design opacity:0 checkbox inputs), find the
    // VISIBLE element that a real user would click. A real user clicks what they SEE,
    // not the hidden input underneath.
    let visibleX = null;
    let visibleY = null;
    if (isHidden) {
      // Strategy 1: Check if there's a visible sibling (Ant Design renders a <span>
      // next to the hidden <input> as the visual checkbox)
      const parent = el.parentElement;
      if (parent) {
        for (const sibling of parent.children) {
          if (sibling === el) continue;
          const sStyle = getComputedStyle(sibling);
          const sVisible = parseFloat(sStyle.opacity || '1') > 0
            && sStyle.display !== 'none'
            && sStyle.visibility !== 'hidden';
          if (sVisible) {
            const sr = sibling.getBoundingClientRect();
            if (sr.width > 0 && sr.height > 0) {
              visibleX = sr.left + sr.width / 2;
              visibleY = sr.top + sr.height / 2;
              break;
            }
          }
        }
      }
      // Strategy 2: Check the parent element itself as the click target
      if (visibleX === null && parent) {
        const pStyle = getComputedStyle(parent);
        const pVisible = parseFloat(pStyle.opacity || '1') > 0
          && pStyle.display !== 'none'
          && pStyle.visibility !== 'hidden';
        if (pVisible) {
          const pr = parent.getBoundingClientRect();
          if (pr.width > 0 && pr.height > 0) {
            visibleX = pr.left + pr.width / 2;
            visibleY = pr.top + pr.height / 2;
          }
        }
      }
      // Strategy 3: Use elementFromPoint at the hidden element's position
      // to find what the user actually sees and would click
      if (visibleX === null) {
        const topEl = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (topEl && topEl !== el) {
          const tr = topEl.getBoundingClientRect();
          visibleX = tr.left + tr.width / 2;
          visibleY = tr.top + tr.height / 2;
        }
      }
    }

    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      width: r.width,
      height: r.height,
      tagName: el.tagName,
      typeAttr: (el.getAttribute && el.getAttribute('type')) || '',
      classes: el.className && typeof el.className === 'string' ? el.className : '',
      hidden: isHidden,
      small: r.width < 16 || r.height < 16,
      offScreen: wasOffScreen,
      visibleTargetX: visibleX,
      visibleTargetY: visibleY,
    };
  })()`;

  return runtimeEvalValue<ElementInfo>(tabId, buildScript(target.type === 'css'));
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

/**
 * Perform a CDP mouse click — simulates real human mouse behavior with
 * Bézier-curve movement, randomized delays, and natural press/release timing.
 * This is the primary click method as it behaves like a real user.
 */
async function performCdpClick(
  tabId: number,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  doubleClick: boolean
): Promise<void> {
  // Bézier-curve mouse move for realism
  const startPos = { x: Math.max(0, x - 100), y: Math.max(0, y - 40) };
  const midX = (startPos.x + x) / 2 + (Math.random() * 20 - 10);
  const midY = (startPos.y + y) / 2 + (Math.random() * 20 - 10);
  const curve = bezierCurve(startPos, { x: midX, y: midY }, { x, y }, 4);

  for (const point of curve) {
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y, pointerType: 'mouse',
    });
  }

  await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount: 1, pointerType: 'mouse',
  });
  await randomDelay(30, 80);
  await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount: 1, pointerType: 'mouse',
  });

  if (doubleClick) {
    await randomDelay(40, 100);
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x, y, button: 'left', clickCount: 2, pointerType: 'mouse',
    });
    await randomDelay(30, 60);
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x, y, button: 'left', clickCount: 2, pointerType: 'mouse',
    });
  }
}

/**
 * JS click fallback — only used when explicitly requested via method: 'js'.
 * Dispatches synthetic DOM events. NOT preferred because it bypasses the
 * browser's native event pipeline (doesn't behave like a real user).
 */
async function performJsClick(tabId: number, target: TargetSpec, doubleClick: boolean): Promise<boolean> {
  if (target.type === 'coordinates') {
    const { x, y } = target.value as { x: number; y: number };
    const script = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return false;
      try { el.focus && el.focus(); } catch (e) {}
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
      ${doubleClick ? `el.dispatchEvent(new MouseEvent('dblclick', opts));` : ''}
      return true;
    })()`;
    const ok = await runtimeEvalValue<boolean>(tabId, script);
    return !!ok;
  }

  const selector = target.value as string;
  const findAndClick = target.type === 'css'
    ? `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        try { el.focus && el.focus(); } catch (e) {}
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        if (typeof el.click === 'function') { el.click(); } else { el.dispatchEvent(new MouseEvent('click', opts)); }
        ${doubleClick ? `el.dispatchEvent(new MouseEvent('dblclick', opts));` : ''}
        return true;
      })()`
    : `(() => {
        const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const el = res.singleNodeValue;
        if (!el || !(el instanceof Element)) return false;
        try { el.focus && el.focus(); } catch (e) {}
        const r = el.getBoundingClientRect();
        const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        if (typeof el.click === 'function') { el.click(); } else { el.dispatchEvent(new MouseEvent('click', opts)); }
        ${doubleClick ? `el.dispatchEvent(new MouseEvent('dblclick', opts));` : ''}
        return true;
      })()`;
  const ok = await runtimeEvalValue<boolean>(tabId, findAndClick);
  return !!ok;
}

export function registerClickHandlers(): void {
  registerHandler('click_element', async (params, tabId) => {
    const { target, button = 'left', doubleClick = false, method = 'auto' } = params as {
      target: TargetSpec;
      button?: 'left' | 'right' | 'middle';
      doubleClick?: boolean;
      method?: 'auto' | 'cdp' | 'js';
    };

    await debuggerManager.ensureAttached(tabId);
    const coordsOnly = target.type === 'coordinates';
    const info = await resolveElementInfo(tabId, target);
    if (!info) {
      throw new Error(`Element not found: ${coordsOnly ? 'coordinates' : target.value}`);
    }

    // If the element was off-screen, give the browser a frame to settle after scrolling
    if (info.offScreen) {
      await new Promise((r) => setTimeout(r, 100));
      // Re-resolve coordinates after scroll (position may have changed)
      if (!coordsOnly) {
        const freshInfo = await resolveElementInfo(tabId, target);
        if (freshInfo) {
          info.x = freshInfo.x;
          info.y = freshInfo.y;
          info.visibleTargetX = freshInfo.visibleTargetX;
          info.visibleTargetY = freshInfo.visibleTargetY;
        }
      }
    }

    // Only use JS click when explicitly requested
    if (method === 'js') {
      const ok = await performJsClick(tabId, target, doubleClick);
      if (!ok) {
        throw new Error(`JS click failed — element not found: ${coordsOnly ? 'coordinates' : target.value}`);
      }
      return { x: info.x, y: info.y, button, doubleClick, method: 'js' };
    }

    // CDP click (real user simulation) — always the default for 'auto' and 'cdp'
    // For hidden elements, click the VISIBLE target that a real user would see
    let clickX = info.x;
    let clickY = info.y;
    if (info.hidden && info.visibleTargetX != null && info.visibleTargetY != null) {
      clickX = info.visibleTargetX;
      clickY = info.visibleTargetY;
    }

    try {
      await performCdpClick(tabId, clickX, clickY, button, doubleClick);
      return { x: clickX, y: clickY, button, doubleClick, method: 'cdp' };
    } catch (err) {
      // CDP failed — only fall back to JS if method was 'auto' (never for explicit 'cdp')
      if (method === 'auto' && !coordsOnly) {
        const ok = await performJsClick(tabId, target, doubleClick);
        if (ok) return { x: info.x, y: info.y, button, doubleClick, method: 'js-fallback' };
      }
      throw err;
    }
  });
}
