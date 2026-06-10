import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface AXNode {
  nodeId: string;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: string };
  properties?: Array<{ name: string; value?: { value?: string } }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

async function getAXTree(tabId: number): Promise<AXNode[]> {
  await debuggerManager.enableDomain(tabId, 'Accessibility');
  const result = (await debuggerManager.sendCommand(tabId, 'Accessibility.getFullAXTree')) as {
    nodes: AXNode[];
  };
  return result.nodes;
}

interface FormatOptions {
  filter?: string;          // lowercase substring — only keep lines (and their ancestors) whose role or name contains this
  skipInteresting?: boolean;// when true, drop nodes that are pure presentational structure (no name, no role, no state)
}

function collectProps(node: AXNode): string[] {
  const props: string[] = [];
  const states = ['focused', 'disabled', 'checked', 'selected', 'expanded', 'required', 'invalid'];
  for (const prop of node.properties || []) {
    if (states.includes(prop.name) && prop.value?.value === 'true') {
      props.push(`[${prop.name}]`);
    }
    if (prop.name === 'url' && prop.value?.value) {
      props.push(`[url=${prop.value.value}]`);
    }
    if (prop.name === 'level' && prop.value?.value) {
      props.push(`[level=${prop.value.value}]`);
    }
  }
  const value = node.value?.value;
  if (value !== undefined && value !== '') {
    props.push(`[value="${value}"]`);
  }
  return props;
}

function isInteresting(node: AXNode): boolean {
  const role = node.role?.value || '';
  const name = node.name?.value || '';
  if (name) return true;
  if (role && role !== 'generic' && role !== 'none' && role !== 'InlineTextBox' && role !== 'StaticText') return true;
  if ((node.properties || []).some(p => ['focused', 'disabled', 'checked', 'selected', 'expanded'].includes(p.name) && p.value?.value === 'true')) return true;
  return false;
}

function matchesFilter(node: AXNode, filterLower: string): boolean {
  const role = (node.role?.value || '').toLowerCase();
  const name = (node.name?.value || '').toLowerCase();
  const value = String(node.value?.value || '').toLowerCase();
  return role.includes(filterLower) || name.includes(filterLower) || value.includes(filterLower);
}

function formatAXTree(
  nodes: AXNode[],
  nodeId: string,
  depth = 0,
  opts: FormatOptions = {},
  byId?: Map<string, AXNode>
): string {
  const lookup = byId ?? new Map(nodes.map(n => [n.nodeId, n]));
  const node = lookup.get(nodeId);
  if (!node) return '';

  // When filtering, only include this subtree if the node itself matches or any descendant does.
  if (opts.filter) {
    const anyMatch = subtreeMatches(node, opts.filter.toLowerCase(), lookup);
    if (!anyMatch) return '';
  }

  const role = node.role?.value || '';
  const name = node.name?.value || '';
  const props = collectProps(node);

  const shouldSkipSelf = opts.skipInteresting && !isInteresting(node);

  let line = '';
  if (!shouldSkipSelf) {
    const indent = '  '.repeat(depth);
    line = `${indent}- ${role}`;
    if (name) line += ` "${name}"`;
    if (props.length) line += ` ${props.join(' ')}`;
    line += '\n';
  }

  const childDepth = shouldSkipSelf ? depth : depth + 1;
  for (const childId of node.childIds || []) {
    line += formatAXTree(nodes, childId, childDepth, opts, lookup);
  }
  return line;
}

function subtreeMatches(node: AXNode, filterLower: string, lookup: Map<string, AXNode>): boolean {
  if (matchesFilter(node, filterLower)) return true;
  for (const cid of node.childIds || []) {
    const c = lookup.get(cid);
    if (c && subtreeMatches(c, filterLower, lookup)) return true;
  }
  return false;
}

function filterAXTreeBySelector(nodes: AXNode[], rootNodeId: string, selector: string, tabId: number): Promise<string> {
  // For selector filtering, we return the full tree and let the client filter,
  // or we can use Runtime.evaluate to find the backendDOMNodeId and then match.
  // Simpler approach: return full tree for now.
  return Promise.resolve(formatAXTree(nodes, rootNodeId));
}

export function registerAccessibilityHandlers(): void {
  registerHandler('browser_snapshot', async (params, tabId) => {
    const {
      maxChars,
      filter,
      interestingOnly,
      offset = 0,
    } = params as {
      maxChars?: number;
      filter?: string;
      interestingOnly?: boolean;
      offset?: number;
    };

    const nodes = await getAXTree(tabId);
    const root = nodes[0];
    if (!root) return { snapshot: '', totalChars: 0, truncated: false, offset: 0, nextOffset: null };

    const snapshot = formatAXTree(nodes, root.nodeId, 0, {
      filter: filter || undefined,
      skipInteresting: interestingOnly ?? (!filter), // on large pages, default to skipping filler roles
    });

    const totalChars = snapshot.length;
    const start = Math.max(0, Math.min(offset, totalChars));
    const limit = Math.max(4_000, Math.min(maxChars ?? 40_000, 500_000));
    const end = Math.min(totalChars, start + limit);
    const slice = snapshot.slice(start, end);
    const truncated = end < totalChars;

    return {
      snapshot: slice,
      totalChars,
      returnedChars: slice.length,
      offset: start,
      nextOffset: truncated ? end : null,
      truncated,
      hint: truncated
        ? `Response truncated at ${limit} chars. Call again with offset=${end} to continue, or pass filter="<substring>" to narrow the tree.`
        : undefined,
    };
  });

  registerHandler('get_element_layout', async (params, tabId) => {
    const { selector, includeAll } = params as { selector?: string; includeAll?: boolean };
    await debuggerManager.ensureAttached(tabId);

    const script = includeAll
      ? `(() => {
          const all = Array.from(document.querySelectorAll('*'));
          const visible = all.filter(el => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          }).slice(0, 200);
          return visible.map(el => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return {
              selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0,2).join('.') : ''),
              tagName: el.tagName,
              boundingRect: { x: r.x, y: r.y, width: r.width, height: r.height },
              overflow: s.overflow,
              zIndex: s.zIndex,
              position: s.position,
              display: s.display,
              visibility: s.visibility,
              opacity: s.opacity,
            };
          });
        })()`
      : `(() => {
          const el = document.querySelector(${JSON.stringify(selector || 'body')});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            selector: ${JSON.stringify(selector || 'body')},
            tagName: el.tagName,
            boundingRect: { x: r.x, y: r.y, width: r.width, height: r.height },
            overflow: s.overflow,
            zIndex: s.zIndex,
            position: s.position,
            display: s.display,
            visibility: s.visibility,
            opacity: s.opacity,
          };
        })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('detect_layout_issues', async (params, tabId) => {
    await debuggerManager.ensureAttached(tabId);
    const script = `(() => {
      const issues = [];
      const all = Array.from(document.querySelectorAll('*'));
      const viewportW = window.innerWidth;
      const viewportH = window.innerHeight;

      // Overflow
      for (const el of all) {
        if (el.scrollWidth > el.clientWidth + 1) {
          issues.push({ type: 'overflow', selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), description: 'Horizontal overflow', details: { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth } });
        }
        if (el.scrollHeight > el.clientHeight + 1) {
          issues.push({ type: 'overflow', selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''), description: 'Vertical overflow', details: { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } });
        }
      }

      // Overlap & clipping
      const rects = [];
      for (const el of all.slice(0, 500)) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          rects.push({ el, r, selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') });
        }
      }
      for (let i = 0; i < rects.length; i++) {
        const a = rects[i];
        // Clipping
        if (a.r.right > viewportW + 5 || a.r.bottom > viewportH + 5) {
          issues.push({ type: 'clipping', selector: a.selector, description: 'Element extends beyond viewport', details: { right: a.r.right, bottom: a.r.bottom, viewportW, viewportH } });
        }
        // Overlap
        for (let j = i + 1; j < rects.length; j++) {
          const b = rects[j];
          if (!(a.r.right < b.r.left || a.r.left > b.r.right || a.r.bottom < b.r.top || a.r.top > b.r.bottom)) {
            const az = parseInt(getComputedStyle(a.el).zIndex || '0', 10);
            const bz = parseInt(getComputedStyle(b.el).zIndex || '0', 10);
            if (Math.abs(az - bz) > 100) {
              issues.push({ type: 'z-index', selector: a.selector + ' vs ' + b.selector, description: 'Large z-index difference may cause stacking issues', details: { zIndexA: az, zIndexB: bz } });
            }
          }
        }
      }

      return issues.slice(0, 100);
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_accessibility_tree', async (params, tabId) => {
    const { selector } = params as { selector?: string };
    const nodes = await getAXTree(tabId);
    if (selector) {
      const root = nodes[0];
      const snapshot = root ? formatAXTree(nodes, root.nodeId) : '';
      return { rawNodes: nodes, snapshot };
    }
    return { rawNodes: nodes };
  });

  registerHandler('diff_page_source', async (params, tabId) => {
    const { beforeHtml, afterHtml } = params as { beforeHtml: string; afterHtml: string };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      function parseHtml(html) {
        const parser = new DOMParser();
        return parser.parseFromString(html, 'text/html');
      }

      function diffNodes(oldNode, newNode, path = 'html') {
        const changes = [];
        if (!oldNode && !newNode) return changes;
        if (!oldNode) {
          changes.push({ type: 'added', path, tagName: newNode.tagName, text: (newNode.textContent || '').trim().substring(0, 200) });
          return changes;
        }
        if (!newNode) {
          changes.push({ type: 'removed', path, tagName: oldNode.tagName });
          return changes;
        }
        if (oldNode.nodeType !== newNode.nodeType) {
          changes.push({ type: 'nodeTypeChanged', path, from: oldNode.nodeType, to: newNode.nodeType });
          return changes;
        }
        if (oldNode.nodeType === Node.TEXT_NODE) {
          if (oldNode.textContent !== newNode.textContent) {
            changes.push({ type: 'textChanged', path, from: oldNode.textContent, to: newNode.textContent });
          }
          return changes;
        }
        if (oldNode.nodeType === Node.ELEMENT_NODE) {
          if (oldNode.tagName !== newNode.tagName) {
            changes.push({ type: 'tagChanged', path, from: oldNode.tagName, to: newNode.tagName });
          }
          // Attribute diff
          const oldAttrs = {};
          for (const attr of oldNode.attributes || []) oldAttrs[attr.name] = attr.value;
          const newAttrs = {};
          for (const attr of newNode.attributes || []) newAttrs[attr.name] = attr.value;
          for (const key of Object.keys(oldAttrs)) {
            if (!(key in newAttrs)) {
              changes.push({ type: 'attributeRemoved', path, attribute: key });
            } else if (oldAttrs[key] !== newAttrs[key]) {
              changes.push({ type: 'attributeChanged', path, attribute: key, from: oldAttrs[key], to: newAttrs[key] });
            }
          }
          for (const key of Object.keys(newAttrs)) {
            if (!(key in oldAttrs)) {
              changes.push({ type: 'attributeAdded', path, attribute: key, value: newAttrs[key] });
            }
          }
          // Children diff
          const oldChildren = Array.from(oldNode.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE && n.textContent.trim());
          const newChildren = Array.from(newNode.childNodes).filter(n => n.nodeType === Node.ELEMENT_NODE || n.nodeType === Node.TEXT_NODE && n.textContent.trim());
          const maxLen = Math.max(oldChildren.length, newChildren.length);
          for (let i = 0; i < maxLen; i++) {
            const childPath = path + ' > ' + (oldChildren[i]?.tagName || newChildren[i]?.tagName || 'text') + ':' + i;
            changes.push(...diffNodes(oldChildren[i], newChildren[i], childPath));
          }
        }
        return changes;
      }

      const beforeDoc = parseHtml(${JSON.stringify(beforeHtml)});
      const afterDoc = parseHtml(${JSON.stringify(afterHtml)});
      const changes = diffNodes(beforeDoc.documentElement, afterDoc.documentElement);
      return {
        changeCount: changes.length,
        added: changes.filter(c => c.type === 'added').length,
        removed: changes.filter(c => c.type === 'removed').length,
        attributeChanges: changes.filter(c => c.type.includes('attribute')).length,
        textChanges: changes.filter(c => c.type === 'textChanged').length,
        changes: changes.slice(0, 200),
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });
}
