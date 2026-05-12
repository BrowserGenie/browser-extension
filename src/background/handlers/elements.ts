import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

function generateUniqueSelector(el: Element): string {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 2).join('.');
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

    const fullScript = `
      (() => {
        function generateUniqueSelector(el) {
          if (el.id) return '#' + el.id;
          const tag = el.tagName.toLowerCase();
          const classes = Array.from(el.classList).slice(0, 2).join('.');
          let selector = classes ? tag + '.' + classes : tag;
          if (tag === 'a' && el.getAttribute('href')) selector += '[href="' + el.getAttribute('href') + '"]';
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length > 1) {
              const index = siblings.indexOf(el) + 1;
              selector += ':nth-of-type(' + index + ')';
            }
            if (parent.tagName.toLowerCase() !== 'html') {
              selector = generateUniqueSelector(parent) + ' > ' + selector;
            }
          }
          return selector;
        }
        function hasRole(el, role) {
          const explicit = el.getAttribute('role');
          if (explicit === role) return true;
          // Semantic HTML fallback
          const tag = el.tagName.toLowerCase();
          const semanticMap = {
            button: 'button',
            a: 'link',
            input: el.type || 'textbox',
            textarea: 'textbox',
            select: 'combobox',
            option: 'option',
            ul: 'list',
            ol: 'list',
            li: 'listitem',
            nav: 'navigation',
            main: 'main',
            aside: 'complementary',
            header: 'banner',
            footer: 'contentinfo',
            h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading',
            table: 'table',
            form: 'form',
            img: 'img',
          };
          if (semanticMap[tag] === role) return true;
          if (tag === 'input') {
            const type = el.type;
            if (role === 'checkbox' && type === 'checkbox') return true;
            if (role === 'radio' && type === 'radio') return true;
            if (role === 'textbox' && (type === 'text' || type === 'email' || type === 'password' || type === 'search' || type === 'url')) return true;
            if (role === 'button' && (type === 'submit' || type === 'button' || type === 'reset')) return true;
          }
          return false;
        }
        const text = ${JSON.stringify(text)};
        const role = ${JSON.stringify(role)};
        const ariaLabel = ${JSON.stringify(ariaLabel)};
        const css = ${JSON.stringify(css)};
        const xpath = ${JSON.stringify(xpath)};
        const nth = ${JSON.stringify(nth)};
        let results = [];

        if (css) {
          const el = document.querySelector(css);
          if (el) results.push(el);
        } else if (xpath) {
          const res = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          for (let i = 0; i < res.snapshotLength; i++) results.push(res.snapshotItem(i));
        } else {
          // Collect candidates. For text matching, prefer the SMALLEST subtree whose
          // own text (or a short descendant's text) matches — textContent propagates
          // up to <body>, so a naive substring check wrongly matches ancestors.
          const all = Array.from(document.querySelectorAll('body *'));
          results = all.filter(el => {
            if (role && !hasRole(el, role)) return false;
            if (ariaLabel && !(el.getAttribute('aria-label') || '').includes(ariaLabel)) return false;
            if (text) {
              const txt = (el.textContent || '').trim();
              if (!txt.includes(text)) return false;
              // Reject matches that only hit because the element wraps a deeper match.
              // Keep this element only if no *child* element also contains the text.
              const childMatches = Array.from(el.children).some(
                (c) => (c.textContent || '').includes(text)
              );
              if (childMatches) return false;
            }
            return true;
          });
          // Sort by rendered area ascending so the tightest wrapper wins.
          if (text) {
            results.sort((a, b) => {
              const ar = a.getBoundingClientRect();
              const br = b.getBoundingClientRect();
              return (ar.width * ar.height) - (br.width * br.height);
            });
          }
        }
        const el = results[nth];
        if (!el) return { found: false, candidateCount: results.length };
        // Safety net: callers should never get <body> back from a find_element(text=...)
        // call when the text didn't match a specific element — that's a false positive.
        if (el.tagName === 'BODY' && (text || role || ariaLabel)) {
          return { found: false, candidateCount: 0, reason: 'no specific element matched' };
        }
        const r = el.getBoundingClientRect();
        const attrs = {};
        for (const attr of el.attributes) {
          attrs[attr.name] = attr.value;
        }
        return {
          found: true,
          selector: generateUniqueSelector(el),
          tagName: el.tagName,
          text: el.textContent.trim().substring(0, 200),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
          attributes: attrs,
        };
      })()
    `;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: fullScript,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_element_state', async (params, tabId) => {
    const { selector, selectorType = 'css' } = params as { selector: string; selectorType?: 'css' | 'xpath' };
    await debuggerManager.ensureAttached(tabId);

    const script = selectorType === 'css'
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return { exists: false };
          return {
            exists: true,
            visible: el.offsetParent !== null && el.getBoundingClientRect().width > 0,
            enabled: !el.disabled,
            focused: document.activeElement === el,
            checked: !!el.checked,
            selected: !!el.selected,
            readOnly: !!el.readOnly,
            required: !!el.required,
            valid: el.checkValidity ? el.checkValidity() : true,
            validationMessage: el.validationMessage || '',
            tagName: el.tagName,
            textContent: el.textContent?.trim().substring(0, 500),
            value: el.value,
            type: el.type,
            rect: el.getBoundingClientRect().toJSON(),
          };
        })()`
      : `(() => {
          const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = res.singleNodeValue;
          if (!el || !(el instanceof Element)) return { exists: false };
          const htmlEl = el;
          return {
            exists: true,
            visible: htmlEl.offsetParent !== null && htmlEl.getBoundingClientRect().width > 0,
            enabled: !htmlEl.disabled,
            focused: document.activeElement === htmlEl,
            checked: !!htmlEl.checked,
            selected: !!htmlEl.selected,
            readOnly: !!htmlEl.readOnly,
            required: !!htmlEl.required,
            valid: htmlEl.checkValidity ? htmlEl.checkValidity() : true,
            validationMessage: htmlEl.validationMessage || '',
            tagName: htmlEl.tagName,
            textContent: htmlEl.textContent?.trim().substring(0, 500),
            value: htmlEl.value,
            type: htmlEl.type,
            rect: htmlEl.getBoundingClientRect().toJSON(),
          };
        })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
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
