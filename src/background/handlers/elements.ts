import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

function generateUniqueSelector(el: Element): string {
  function escapeCss(str: string): string {
    // Escape characters that are special in CSS selectors: quotes, backslash, etc.
    return str.replace(/([\\"'])/g, '\\$1');
  }
  if (el.id) return '#' + escapeCss(el.id);
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 2).map(escapeCss).join('.');
  let selector = classes ? `${tag}.${classes}` : tag;
  const parent = el.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (siblings.length > 1) {
      const index = siblings.indexOf(el) + 1;
      selector += `:nth-of-type(${index})`;
    }
    if (parent.tagName.toLowerCase() !== 'html') {
      selector = generateUniqueSelector(parent) + ' > ' + selector;
    }
  }
  return selector;
}

export function registerElementHandlers(): void {
  registerHandler('find_element', async (params, tabId) => {
    const { text, role, ariaLabel, css, xpath, nth = 0 } = params as {
      text?: string;
      role?: string;
      ariaLabel?: string;
      css?: string;
      xpath?: string;
      nth?: number;
    };
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'DOM');

    // --- Path 1: CSS selector via pure CDP (no JS injection) ---
    if (css) {
      const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument')) as { root: { nodeId: number } };
      const queryResult = (await debuggerManager.sendCommand(tabId, 'DOM.querySelectorAll', {
        nodeId: doc.root.nodeId,
        selector: css,
      })) as { nodeIds: number[] };

      const nodeIds = queryResult.nodeIds || [];
      if (nodeIds.length === 0) {
        return { found: false, candidateCount: 0 };
      }
      const targetNodeId = nodeIds[Math.min(nth, nodeIds.length - 1)];

      const [nodeInfo, boxModel] = await Promise.all([
        debuggerManager.sendCommand(tabId, 'DOM.describeNode', {
          nodeId: targetNodeId,
          depth: 0,
          pierce: false,
        }) as Promise<{ node: { nodeName: string; attributes?: string[]; nodeId: number } }>,
        debuggerManager.sendCommand(tabId, 'DOM.getBoxModel', { nodeId: targetNodeId }).catch(() => null),
      ]);

      const attrs: Record<string, string> = {};
      const attrList = nodeInfo.node.attributes || [];
      for (let i = 0; i < attrList.length; i += 2) {
        attrs[attrList[i]] = attrList[i + 1];
      }

      const model = boxModel as { model: { content: number[]; padding: number[]; border: number[]; margin: number[] } } | null;
      const border = model?.model?.border || [0, 0, 0, 0, 0, 0, 0, 0];
      // border quad: [x1,y1, x2,y2, x3,y3, x4,y4]
      const x = Math.min(border[0], border[2], border[4], border[6]);
      const y = Math.min(border[1], border[3], border[5], border[7]);
      const width = Math.max(border[0], border[2], border[4], border[6]) - x;
      const height = Math.max(border[1], border[3], border[5], border[7]) - y;

      return {
        found: true,
        selector: css,
        tagName: nodeInfo.node.nodeName,
        rect: { x, y, width, height },
        attributes: attrs,
        candidateCount: nodeIds.length,
      };
    }

    // --- Path 2: XPath still needs JS because CDP has no XPath evaluator ---
    if (xpath) {
      const fullScript = `
        (() => {
          const res = document.evaluate(${JSON.stringify(xpath)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const total = res.snapshotLength;
          if (total === 0) return { found: false, candidateCount: 0 };
          const el = res.snapshotItem(Math.min(${nth}, total - 1));
          if (!el || !(el instanceof Element)) return { found: false, candidateCount: total };
          const r = el.getBoundingClientRect();
          const attrs = {};
          for (const attr of el.attributes) {
            attrs[attr.name] = attr.value;
          }
          return {
            found: true,
            selector: ${JSON.stringify(xpath)},
            tagName: el.tagName,
            text: (el.textContent || '').trim().substring(0, 200),
            rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            attributes: attrs,
            candidateCount: total,
          };
        })()
      `;
      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: fullScript,
        returnByValue: true,
      })) as { result: { value: unknown } };
      return result.result.value;
    }

    // --- Path 3: Text / role / ariaLabel via Accessibility domain (no JS) ---
    await debuggerManager.enableDomain(tabId, 'Accessibility');
    const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument')) as { root: { nodeId: number } };

    const queryParams: Record<string, unknown> = { nodeId: doc.root.nodeId };
    if (role) queryParams.role = role;
    if (ariaLabel || text) queryParams.accessibleName = ariaLabel || text;

    const axResult = (await debuggerManager.sendCommand(tabId, 'Accessibility.queryAXTree', queryParams)) as {
      nodes: Array<{
        backendDOMNodeId?: number;
        nodeId?: number;
        role?: { value?: string };
        name?: { value?: string };
      }>;
    };

    const nodes = axResult.nodes || [];
    // Filter nodes that actually match text if no explicit ariaLabel was given
    let matches = nodes;
    if (text && !ariaLabel) {
      const textLower = text.toLowerCase();
      matches = nodes.filter(n => (n.name?.value || '').toLowerCase().includes(textLower));
    }
    if (role) {
      const roleLower = role.toLowerCase();
      matches = matches.filter(n => (n.role?.value || '').toLowerCase() === roleLower);
    }

    if (matches.length === 0) {
      return { found: false, candidateCount: nodes.length };
    }

    const target = matches[Math.min(nth, matches.length - 1)];
    const backendNodeId = target.backendDOMNodeId || target.nodeId;
    if (!backendNodeId) {
      return { found: false, candidateCount: matches.length, reason: 'No backend node id available' };
    }

    // Convert backend node id to frontend node id so we can describe it
    const pushResult = (await debuggerManager.sendCommand(tabId, 'DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [backendNodeId],
    })) as { nodeIds: number[] };

    const targetNodeId = pushResult.nodeIds?.[0];
    if (!targetNodeId) {
      return { found: false, candidateCount: matches.length, reason: 'Could not resolve node' };
    }

    const [nodeInfo, boxModel] = await Promise.all([
      debuggerManager.sendCommand(tabId, 'DOM.describeNode', {
        nodeId: targetNodeId,
        depth: 0,
        pierce: false,
      }) as Promise<{ node: { nodeName: string; attributes?: string[]; nodeId: number } }>,
      debuggerManager.sendCommand(tabId, 'DOM.getBoxModel', { nodeId: targetNodeId }).catch(() => null),
    ]);

    const attrs: Record<string, string> = {};
    const attrList = nodeInfo.node.attributes || [];
    for (let i = 0; i < attrList.length; i += 2) {
      attrs[attrList[i]] = attrList[i + 1];
    }

    const model = boxModel as { model: { content: number[]; padding: number[]; border: number[]; margin: number[] } } | null;
    const border = model?.model?.border || [0, 0, 0, 0, 0, 0, 0, 0];
    const x = Math.min(border[0], border[2], border[4], border[6]);
    const y = Math.min(border[1], border[3], border[5], border[7]);
    const width = Math.max(border[0], border[2], border[4], border[6]) - x;
    const height = Math.max(border[1], border[3], border[5], border[7]) - y;

    return {
      found: true,
      selector: `[AX role=${target.role?.value} name="${target.name?.value}"]`,
      tagName: nodeInfo.node.nodeName,
      text: (target.name?.value || '').substring(0, 200),
      rect: { x, y, width, height },
      attributes: attrs,
      candidateCount: matches.length,
    };
  });

  registerHandler('get_element_state', async (params, tabId) => {
    const { selector, selectorType = 'css' } = params as { selector: string; selectorType?: 'css' | 'xpath' };
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'DOM');
    await debuggerManager.enableDomain(tabId, 'Accessibility');

    let nodeId: number | undefined;

    if (selectorType === 'css') {
      const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument')) as { root: { nodeId: number } };
      const queryResult = (await debuggerManager.sendCommand(tabId, 'DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector,
      })) as { nodeId: number };
      nodeId = queryResult.nodeId;
    } else {
      // XPath still needs a one-line JS evaluation to resolve the element
      const xpathResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `(() => {
          const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = res.singleNodeValue;
          return el && el instanceof Element ? el.tagName : null;
        })()`,
        returnByValue: true,
      })) as { result: { value: string | null } };
      if (!xpathResult.result.value) {
        return { exists: false };
      }
      // After confirming element exists via XPath, we can't easily get CDP nodeId from it.
      // Fall back to a minimal JS extraction for XPath paths.
      const script = `(() => {
        const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        const el = res.singleNodeValue;
        if (!el || !(el instanceof Element)) return { exists: false };
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return {
          exists: true,
          visible: el.offsetParent !== null && rect.width > 0,
          enabled: !el.disabled,
          focused: document.activeElement === el,
          hovered: false,
          active: false,
          focusWithin: false,
          checked: !!el.checked,
          selected: !!el.selected,
          readOnly: !!el.readOnly,
          required: !!el.required,
          valid: el.checkValidity ? el.checkValidity() : true,
          validationMessage: el.validationMessage || '',
          ariaExpanded: el.getAttribute('aria-expanded'),
          ariaPressed: el.getAttribute('aria-pressed'),
          ariaSelected: el.getAttribute('aria-selected'),
          ariaHasPopup: el.getAttribute('aria-haspopup'),
          ariaHidden: el.getAttribute('aria-hidden'),
          opacity: style.opacity,
          pointerEvents: style.pointerEvents,
          overflow: style.overflow,
          tagName: el.tagName,
          textContent: (el.textContent || '').trim().substring(0, 500),
          value: el.value,
          type: el.type,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        };
      })()`;
      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: unknown } };
      return result.result.value;
    }

    if (!nodeId) {
      return { exists: false };
    }

    // Get DOM details
    const nodeInfo = (await debuggerManager.sendCommand(tabId, 'DOM.describeNode', {
      nodeId,
      depth: 0,
      pierce: false,
    })) as { node: { nodeName: string; attributes?: string[]; backendNodeId?: number } };

    const attrs: Record<string, string> = {};
    const attrList = nodeInfo.node.attributes || [];
    for (let i = 0; i < attrList.length; i += 2) {
      attrs[attrList[i]] = attrList[i + 1];
    }

    // Get box model for rect and visibility
    const boxModel = await debuggerManager.sendCommand(tabId, 'DOM.getBoxModel', { nodeId }).catch(() => null) as {
      model: { content: number[]; padding: number[]; border: number[]; margin: number[] };
    } | null;

    const border = boxModel?.model?.border || [0, 0, 0, 0, 0, 0, 0, 0];
    const x = Math.min(border[0], border[2], border[4], border[6]);
    const y = Math.min(border[1], border[3], border[5], border[7]);
    const width = Math.max(border[0], border[2], border[4], border[6]) - x;
    const height = Math.max(border[1], border[3], border[5], border[7]) - y;
    const visible = width > 0 && height > 0;

    // Get accessibility properties
    const axResult = (await debuggerManager.sendCommand(tabId, 'Accessibility.queryAXTree', {
      nodeId,
    })) as {
      nodes: Array<{
        role?: { value?: string };
        name?: { value?: string };
        value?: { value?: string };
        properties?: Array<{ name: string; value?: { value?: string } }>;
      }>;
    };

    const axNode = axResult.nodes?.[0];
    const axProps = new Map((axNode?.properties || []).map(p => [p.name, p.value?.value]));

    // Get computed styles via CSS domain
    let opacity = '';
    let pointerEvents = '';
    let overflow = '';
    try {
      await debuggerManager.enableDomain(tabId, 'CSS');
      const stylesResult = (await debuggerManager.sendCommand(tabId, 'CSS.getComputedStyleForNode', {
        nodeId,
      })) as { computedStyle: Array<{ name: string; value: string }> };
      const styleMap = new Map(stylesResult.computedStyle.map(s => [s.name, s.value]));
      opacity = styleMap.get('opacity') || '';
      pointerEvents = styleMap.get('pointer-events') || '';
      overflow = styleMap.get('overflow') || '';
    } catch {
      // CSS domain may not be available for all node types
    }

    return {
      exists: true,
      visible,
      enabled: axProps.get('disabled') !== 'true',
      focused: axProps.get('focused') === 'true',
      hovered: false, // CDP does not expose hover state directly
      active: false,  // CDP does not expose active state directly
      focusWithin: false, // CDP does not expose focus-within directly
      checked: axProps.get('checked') === 'true',
      selected: axProps.get('selected') === 'true',
      readOnly: axProps.get('readonly') === 'true' || axProps.get('editable') === 'false',
      required: axProps.get('required') === 'true',
      valid: axProps.get('invalid') !== 'true',
      validationMessage: '', // not available via CDP
      ariaExpanded: axProps.get('expanded') || attrs['aria-expanded'],
      ariaPressed: axProps.get('pressed') || attrs['aria-pressed'],
      ariaSelected: axProps.get('selected') || attrs['aria-selected'],
      ariaHasPopup: attrs['aria-haspopup'],
      ariaHidden: attrs['aria-hidden'],
      opacity,
      pointerEvents,
      overflow,
      tagName: nodeInfo.node.nodeName,
      textContent: (axNode?.name?.value || '').substring(0, 500),
      value: axNode?.value?.value,
      type: attrs.type,
      rect: { x, y, width, height },
    };
  });

  registerHandler('query_shadow_dom', async (params, tabId) => {
    const { hostSelector, innerSelector } = params as { hostSelector: string; innerSelector: string };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const host = document.querySelector(${JSON.stringify(hostSelector)});
      if (!host) return { found: false, error: 'Host not found' };
      if (!host.shadowRoot) return { found: false, error: 'No shadow root' };
      const el = host.shadowRoot.querySelector(${JSON.stringify(innerSelector)});
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      return {
        found: true,
        tagName: el.tagName,
        text: el.textContent?.trim().substring(0, 200),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_computed_styles', async (params, tabId) => {
    const { selector, properties, pseudoElement } = params as {
      selector: string;
      properties?: string[];
      pseudoElement?: string;
    };
    await debuggerManager.ensureAttached(tabId);

    // For pseudo-elements, JavaScript is more reliable than CDP's limited pseudo support
    if (pseudoElement) {
      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'Element not found' };
        const s = getComputedStyle(el, ${JSON.stringify(pseudoElement)});
        const styles = {};
        for (let i = 0; i < s.length; i++) {
          const name = s.item(i);
          styles[name] = s.getPropertyValue(name);
        }
        ${properties?.length ? `
        const filtered = {};
        for (const p of ${JSON.stringify(properties)}) {
          if (styles[p] !== undefined) filtered[p] = styles[p];
        }
        return filtered;
        ` : 'return styles;'}
      })()`;
      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: Record<string, string> | { error: string } } };
      if (result.result.value && 'error' in result.result.value) {
        throw new Error(result.result.value.error);
      }
      return result.result.value;
    }

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

    const stylesResult = (await debuggerManager.sendCommand(tabId, 'CSS.getComputedStyleForNode', {
      nodeId: queryResult.nodeId,
    })) as { computedStyle: Array<{ name: string; value: string }> };

    const allStyles: Record<string, string> = {};
    for (const s of stylesResult.computedStyle) {
      allStyles[s.name] = s.value;
    }

    if (properties && properties.length > 0) {
      const filtered: Record<string, string> = {};
      for (const p of properties) {
        if (allStyles[p] !== undefined) filtered[p] = allStyles[p];
      }
      return filtered;
    }

    return allStyles;
  });

  registerHandler('deep_query_shadow_dom', async (params, tabId) => {
    const { hostPath, innerSelector } = params as { hostPath: string[]; innerSelector: string };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const hostPath = ${JSON.stringify(hostPath)};
      const innerSelector = ${JSON.stringify(innerSelector)};
      let root = document;
      for (const hostSel of hostPath) {
        const host = root.querySelector(hostSel);
        if (!host) return { found: false, error: 'Host not found: ' + hostSel };
        if (!host.shadowRoot) return { found: false, error: 'No shadow root on: ' + hostSel };
        root = host.shadowRoot;
      }
      const el = root.querySelector(innerSelector);
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      return {
        found: true,
        tagName: el.tagName,
        text: el.textContent?.trim().substring(0, 200),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_shadow_dom_tree', async (params, tabId) => {
    const { hostSelector, maxDepth = 5 } = params as { hostSelector: string; maxDepth?: number };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      function buildShadowTree(el, depth, maxDepth) {
        if (!el || depth > maxDepth) return null;
        const r = el.getBoundingClientRect();
        const node = {
          tagName: el.tagName,
          id: el.id || null,
          className: el.className && typeof el.className === 'string' ? el.className : null,
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          hasShadowRoot: !!el.shadowRoot,
          children: [],
          shadowChildren: [],
        };
        for (const child of el.children) {
          node.children.push(buildShadowTree(child, depth + 1, maxDepth));
        }
        if (el.shadowRoot) {
          for (const child of el.shadowRoot.children) {
            node.shadowChildren.push(buildShadowTree(child, depth + 1, maxDepth));
          }
        }
        return node;
      }
      const host = document.querySelector(${JSON.stringify(hostSelector)});
      if (!host) return { error: 'Host not found' };
      return { tree: buildShadowTree(host, 0, ${maxDepth}) };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });
}
