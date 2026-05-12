import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface TargetSpec {
  type: 'coordinates' | 'css' | 'xpath';
  value: string | { x: number; y: number };
}

interface ElementInfo {
  x: number; // center x
  y: number; // center y
  width: number;
  height: number;
  tagName: string;
  typeAttr?: string;
  classes?: string;
  hidden: boolean; // hidden input / opacity 0 / invisible overlay situation
  small: boolean; // bounding box below minimum safe click size
}

async function runtimeEvalValue<T>(tabId: number, expr: string): Promise<T | null> {
  const res = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
  })) as { result: { value: T | null } };
  return res.result.value;
}

async function resolveElementInfo(tabId: number, target: TargetSpec): Promise<ElementInfo | null> {
  if (target.type === 'coordinates') {
    const c = target.value as { x: number; y: number };
    return {
      x: c.x, y: c.y, width: 0, height: 0,
      tagName: '', classes: '', hidden: false, small: false,
    };
  }

  const selector = target.value as string;
  await debuggerManager.enableDomain(tabId, 'Runtime');
  const buildScript = (isCss: boolean) => `(() => {
    ${isCss
      ? `const el = document.querySelector(${JSON.stringify(selector)});`
      : `const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue;`}
    if (!el || !(el instanceof Element)) return null;
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const opacityZero = parseFloat(style.opacity || '1') === 0;
    const displayNone = style.display === 'none';
    const visHidden = style.visibility === 'hidden';
    return {
      x: r.left + r.width / 2,
      y: r.top + r.height / 2,
      width: r.width,
      height: r.height,
      tagName: el.tagName,
      typeAttr: (el.getAttribute && el.getAttribute('type')) || '',
      classes: el.className && typeof el.className === 'string' ? el.className : '',
      hidden: opacityZero || displayNone || visHidden,
      small: r.width < 16 || r.height < 16,
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

const BUTTON_MAP: Record<string, number> = { left: 0, middle: 1, right: 2 };

/**
 * Fire a click entirely within the page's JS context. Works for:
 *   - Hidden inputs (e.g. Ant Design's opacity:0 checkboxes where the clickable
 *     span overlay is the real target but CDP mouse events hit the hidden input).
 *   - Tiny/close buttons where Bézier-curve mouse simulation misses or hits a sibling.
 *   - UI-only buttons that have no network side-effect (fast, no CDP round-trips).
 *
 * Returns true if the element was found and clicked.
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

async function performCdpClick(
  tabId: number,
  x: number,
  y: number,
  button: 'left' | 'right' | 'middle',
  doubleClick: boolean
): Promise<void> {
  // Bézier-curve mouse move for slight realism. Kept short so it can never dominate click time.
  const startPos = { x: Math.max(0, x - 100), y: Math.max(0, y - 40) };
  const midX = (startPos.x + x) / 2 + (Math.random() * 20 - 10);
  const midY = (startPos.y + y) / 2 + (Math.random() * 20 - 10);
  const curve = bezierCurve(startPos, { x: midX, y: midY }, { x, y }, 4);

  for (const point of curve) {
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y,
    });
  }

  await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button, clickCount: 1,
  });
  await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button, clickCount: 1,
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
}

function shouldPreferJsClick(info: ElementInfo | null, coordsOnly: boolean): boolean {
  if (coordsOnly) return false;
  if (!info) return false;
  // Ant Design (and similar) checkboxes: hidden <input type="checkbox"> with a span overlay
  if (info.tagName === 'INPUT' && (info.typeAttr === 'checkbox' || info.typeAttr === 'radio') && info.hidden) return true;
  if (info.hidden) return true;
  // Tiny close / pill-remove buttons — CDP Bézier movement can miss or overshoot
  if (info.small) return true;
  return false;
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

    const chosen: 'cdp' | 'js' =
      method === 'cdp' ? 'cdp' :
      method === 'js' ? 'js' :
      shouldPreferJsClick(info, coordsOnly) ? 'js' : 'cdp';

    if (chosen === 'js') {
      const ok = await performJsClick(tabId, target, doubleClick);
      if (!ok) {
        // Fall back to CDP if JS path somehow missed
        await performCdpClick(tabId, info.x, info.y, button, doubleClick);
        return { x: info.x, y: info.y, button, doubleClick, method: 'cdp-fallback' };
      }
      return { x: info.x, y: info.y, button, doubleClick, method: 'js' };
    }

    try {
      await performCdpClick(tabId, info.x, info.y, button, doubleClick);
      return { x: info.x, y: info.y, button, doubleClick, method: 'cdp' };
    } catch (err) {
      // AbortError or similar — try JS fallback once
      if (!coordsOnly) {
        const ok = await performJsClick(tabId, target, doubleClick);
        if (ok) return { x: info.x, y: info.y, button, doubleClick, method: 'js-fallback' };
      }
      throw err;
    }
  });
}
