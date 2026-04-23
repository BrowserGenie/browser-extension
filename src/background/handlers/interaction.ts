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

function bezierCurve(p0: { x: number; y: number }, p1: { x: number; y: number }, p2: { x: number; y: number }, steps: number): Array<{ x: number; y: number }> {
  const points = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x;
    const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y;
    points.push({ x: Math.round(x), y: Math.round(y) });
  }
  return points;
}

function captureSnapshotScript(): string {
  return `(() => {
    const snapshot = [];
    const walk = (el, depth) => {
      if (depth > 3) return;
      const tag = el.tagName.toLowerCase();
      const id = el.id ? '#' + el.id : '';
      const cls = el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : '';
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      snapshot.push({
        tag: tag + id + cls,
        depth,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        display: s.display,
        visibility: s.visibility,
        opacity: s.opacity,
      });
      for (const child of el.children) {
        walk(child, depth + 1);
      }
    };
    walk(document.body, 0);
    return snapshot;
  })()`;
}

export function registerInteractionHandlers(): void {
  registerHandler('hover_and_inspect', async (params, tabId) => {
    const { target, captureChanges = true } = params as { target: TargetSpec; captureChanges?: boolean };
    await debuggerManager.ensureAttached(tabId);

    let before: any[] = [];
    if (captureChanges) {
      const beforeResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: captureSnapshotScript(),
        returnByValue: true,
      })) as { result: { value: any[] } };
      before = beforeResult.result.value;
    }

    const { x, y } = await resolveCoordinates(tabId, target);

    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });

    // Randomized dwell time for human-like behavior
    await randomDelay(50, 150);

    if (!captureChanges) {
      return { x, y, changesDetected: false };
    }

    const afterResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: captureSnapshotScript(),
      returnByValue: true,
    })) as { result: { value: any[] } };
    const after = afterResult.result.value;

    const beforeMap = new Map(before.map((b) => [JSON.stringify(b), b]));
    const afterMap = new Map(after.map((a) => [JSON.stringify(a), a]));

    const newElements = after.filter((a) => !beforeMap.has(JSON.stringify(a)));
    const removedElements = before.filter((b) => !afterMap.has(JSON.stringify(b)));

    return {
      x, y,
      newElements: newElements.slice(0, 20),
      removedElements: removedElements.slice(0, 20),
      changesDetected: newElements.length > 0 || removedElements.length > 0,
    };
  });

  registerHandler('force_pseudo_state', async (params, tabId) => {
    const { selector, pseudoState, clear = true } = params as {
      selector: string;
      pseudoState: string;
      clear?: boolean;
    };
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'DOM');
    await debuggerManager.enableDomain(tabId, 'CSS');

    const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument')) as { root: { nodeId: number } };
    const queryResult = (await debuggerManager.sendCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    })) as { nodeId: number };

    if (!queryResult.nodeId) {
      throw new Error(`Element not found: ${selector}`);
    }

    await debuggerManager.sendCommand(tabId, 'CSS.forcePseudoState', {
      nodeId: queryResult.nodeId,
      forcedPseudoClasses: [pseudoState],
    });

    const stylesResult = (await debuggerManager.sendCommand(tabId, 'CSS.getComputedStyleForNode', {
      nodeId: queryResult.nodeId,
    })) as { computedStyle: Array<{ name: string; value: string }> };

    const computedStyle: Record<string, string> = {};
    for (const s of stylesResult.computedStyle) {
      computedStyle[s.name] = s.value;
    }

    if (clear) {
      await debuggerManager.sendCommand(tabId, 'CSS.forcePseudoState', {
        nodeId: queryResult.nodeId,
        forcedPseudoClasses: [],
      });
    }

    return { selector, pseudoState, computedStyle };
  });

  registerHandler('get_tooltip_text', async (params, tabId) => {
    const { target, waitForTooltip = 200 } = params as { target: TargetSpec; waitForTooltip?: number };
    await debuggerManager.ensureAttached(tabId);

    const { x, y } = await resolveCoordinates(tabId, target);

    // Pre-hover: extract title and aria attributes directly
    const preScript = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return null;
      return {
        title: el.getAttribute('title'),
        ariaDescribedBy: el.getAttribute('aria-describedby'),
        ariaLabelledBy: el.getAttribute('aria-labelledby'),
      };
    })()`;

    const preResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: preScript,
      returnByValue: true,
    })) as { result: { value: { title: string | null; ariaDescribedBy: string | null; ariaLabelledBy: string | null } | null } };
    const preData = preResult.result.value;

    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x, y,
    });

    // Configurable wait for tooltip animations
    await new Promise((r) => setTimeout(r, waitForTooltip));

    const script = `(() => {
      const el = document.elementFromPoint(${x}, ${y});
      if (!el) return { titleAttribute: null, ariaDescribedBy: null, ariaLabelledBy: null, cssTooltip: null, customTooltip: null, allTooltips: [] };
      const title = el.getAttribute('title');
      let ariaDescribedBy = null;
      const describedById = el.getAttribute('aria-describedby');
      if (describedById) {
        const descEl = document.getElementById(describedById);
        if (descEl) ariaDescribedBy = descEl.textContent.trim();
      }
      let ariaLabelledBy = null;
      const labelledById = el.getAttribute('aria-labelledby');
      if (labelledById) {
        const labelEl = document.getElementById(labelledById);
        if (labelEl) ariaLabelledBy = labelEl.textContent.trim();
      }
      const customTooltip = Array.from(document.querySelectorAll('[role="tooltip"]')).find(t => {
        const s = getComputedStyle(t);
        return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
      });
      const allTooltips = [];
      if (title) allTooltips.push(title);
      if (ariaDescribedBy) allTooltips.push(ariaDescribedBy);
      if (ariaLabelledBy) allTooltips.push(ariaLabelledBy);
      if (customTooltip) allTooltips.push(customTooltip.textContent.trim());
      return {
        titleAttribute: title,
        ariaDescribedBy,
        ariaLabelledBy,
        cssTooltip: null,
        customTooltip: customTooltip ? customTooltip.textContent.trim() : null,
        allTooltips,
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });
}
