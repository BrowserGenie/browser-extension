import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface DomTreeNode {
  ref: string;
  tag: string;
  role?: string;
  name?: string;
  id?: string;
  className?: string;
  attributes: Record<string, string>;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  visible: boolean;
  interactive: boolean;
  clickable: boolean;
  children: DomTreeNode[];
  events?: string[];
}

interface DomTreeDelta {
  tabId: number;
  type: 'full' | 'delta' | 'action';
  timestamp: number;
  nodes?: DomTreeNode[];
  changed?: DomTreeNode[];
  removed?: string[];
  action?: { command: string; params: Record<string, unknown> };
}

interface TabDomState {
  tree: DomTreeNode[];
  refMap: Map<string, DomTreeNode>;
  history: DomTreeDelta[];
  lastFullSnapshot: number;
  watching: boolean;
}

const tabStates = new Map<number, TabDomState>();
const MAX_HISTORY = 20;

function getOrCreateState(tabId: number): TabDomState {
  let state = tabStates.get(tabId);
  if (!state) {
    state = {
      tree: [],
      refMap: new Map(),
      history: [],
      lastFullSnapshot: 0,
      watching: true,
    };
    tabStates.set(tabId, state);
  }
  return state;
}

function collectRefs(nodes: DomTreeNode[], set: Set<string>) {
  for (const n of nodes) {
    set.add(n.ref);
    collectRefs(n.children, set);
  }
}

function flattenToMap(nodes: DomTreeNode[], map: Map<string, DomTreeNode>) {
  for (const n of nodes) {
    map.set(n.ref, n);
    flattenToMap(n.children, map);
  }
}

function rebuildRefMap(state: TabDomState) {
  state.refMap.clear();
  flattenToMap(state.tree, state.refMap);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object' || a === null || b === null) return false;
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!bKeys.includes(key)) return false;
    if (!deepEqual(aObj[key], bObj[key])) return false;
  }
  return true;
}

function applyDelta(state: TabDomState, delta: DomTreeDelta) {
  if (delta.type === 'full' && delta.nodes) {
    state.tree = delta.nodes;
    rebuildRefMap(state);
    state.lastFullSnapshot = delta.timestamp;
  } else if (delta.type === 'delta') {
    // Apply removals
    if (delta.removed) {
      for (const ref of delta.removed) {
        state.refMap.delete(ref);
      }
      // Rebuild tree to prune removed nodes (simpler than surgical removal)
      // We keep nodes that are not in removed set
      function prune(nodes: DomTreeNode[]): DomTreeNode[] {
        return nodes
          .filter((n) => !delta.removed!.includes(n.ref))
          .map((n) => ({ ...n, children: prune(n.children) }));
      }
      state.tree = prune(state.tree);
    }

    // Apply changes / additions
    if (delta.changed) {
      for (const changedNode of delta.changed) {
        state.refMap.set(changedNode.ref, changedNode);
      }
      // For additions, we need to graft them into the tree.
      // Since delta only sends changed subtrees, we replace any existing node with same ref.
      function graft(nodes: DomTreeNode[]): DomTreeNode[] {
        return nodes.map((n) => {
          const changed = delta.changed!.find((c) => c.ref === n.ref);
          if (changed) {
            return changed;
          }
          return { ...n, children: graft(n.children) };
        });
      }
      state.tree = graft(state.tree);

      // Also handle brand-new top-level nodes
      const existingRefs = new Set(state.refMap.keys());
      for (const changedNode of delta.changed) {
        if (!existingRefs.has(changedNode.ref)) {
          // New top-level node — add it
          state.tree.push(changedNode);
          state.refMap.set(changedNode.ref, changedNode);
        }
      }
    }

    rebuildRefMap(state);
  }

  // Push to history
  state.history.push(delta);
  if (state.history.length > MAX_HISTORY) {
    state.history.shift();
  }
}

export function recordAction(tabId: number, command: string, params: Record<string, unknown>) {
  const state = getOrCreateState(tabId);
  const delta: DomTreeDelta = {
    tabId,
    type: 'action',
    timestamp: Date.now(),
    action: { command, params },
  };
  state.history.push(delta);
  if (state.history.length > MAX_HISTORY) {
    state.history.shift();
  }
}

export function handleDomTreeUpdate(tabId: number, payload: DomTreeDelta) {
  const state = getOrCreateState(tabId);
  applyDelta(state, payload);
}

export function getDomTree(tabId: number): DomTreeNode[] {
  return getOrCreateState(tabId).tree;
}

export function getDomNode(tabId: number, ref: string): DomTreeNode | undefined {
  return getOrCreateState(tabId).refMap.get(ref);
}

export function getDomHistory(tabId: number, count = MAX_HISTORY): DomTreeDelta[] {
  const state = getOrCreateState(tabId);
  return state.history.slice(-Math.min(count, MAX_HISTORY));
}

export function getDomDiff(tabId: number, stepsBack = 1): { current: DomTreeNode[]; previous: DomTreeNode[]; removed: string[]; added: DomTreeNode[]; changed: DomTreeNode[] } | null {
  const state = getOrCreateState(tabId);
  if (state.history.length < stepsBack + 1) return null;

  // Find the most recent full snapshot at or before the requested step
  let targetIndex = state.history.length - 1 - stepsBack;
  if (targetIndex < 0) targetIndex = 0;

  // Reconstruct tree at targetIndex by replaying history up to that point
  const replayState: TabDomState = {
    tree: [],
    refMap: new Map(),
    history: [],
    lastFullSnapshot: 0,
    watching: true,
  };

  for (let i = 0; i <= targetIndex; i++) {
    const delta = state.history[i];
    if (delta.type === 'full' || delta.type === 'delta') {
      applyDelta(replayState, delta);
    }
  }

  const current = state.tree;
  const previous = replayState.tree;

  const currentRefs = new Set<string>();
  collectRefs(current, currentRefs);
  const previousRefs = new Set<string>();
  collectRefs(previous, previousRefs);

  const removed: string[] = [];
  for (const ref of previousRefs) {
    if (!currentRefs.has(ref)) removed.push(ref);
  }

  const added: DomTreeNode[] = [];
  const changed: DomTreeNode[] = [];
  const stateRefMap = state.refMap;
  for (const [ref, node] of stateRefMap.entries()) {
    if (!previousRefs.has(ref)) {
      added.push(node);
    } else {
      const prevNode = replayState.refMap.get(ref);
      if (prevNode && !deepEqual(node, prevNode)) {
        changed.push(node);
      }
    }
  }

  return { current, previous, removed, added, changed };
}

export function findDomNodes(tabId: number, query: string): Array<{ ref: string; tag: string; role?: string; name?: string; summary: string }> {
  const state = getOrCreateState(tabId);
  const results: Array<{ ref: string; tag: string; role?: string; name?: string; summary: string }> = [];
  const q = query.toLowerCase();

  function search(nodes: DomTreeNode[]) {
    for (const n of nodes) {
      let match = false;
      if (n.tag.toLowerCase().includes(q)) match = true;
      if (n.role?.toLowerCase().includes(q)) match = true;
      if (n.name?.toLowerCase().includes(q)) match = true;
      if (n.id?.toLowerCase().includes(q)) match = true;
      if (n.className?.toLowerCase().includes(q)) match = true;
      for (const [k, v] of Object.entries(n.attributes)) {
        if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) match = true;
      }
      for (const [k, v] of Object.entries(n.styles)) {
        if (k.toLowerCase().includes(q) || v.toLowerCase().includes(q)) match = true;
      }

      if (match) {
        results.push({
          ref: n.ref,
          tag: n.tag,
          role: n.role,
          name: n.name,
          summary: `${n.tag}${n.role ? `[${n.role}]` : ''}${n.name ? ` "${n.name.substring(0, 60)}"` : ''} @${n.ref}`,
        });
      }
      search(n.children);
    }
  }

  search(state.tree);
  return results;
}

export function getClickableRefs(tabId: number): string[] {
  const state = getOrCreateState(tabId);
  const refs: string[] = [];
  function walk(nodes: DomTreeNode[]) {
    for (const n of nodes) {
      if (n.visible && n.clickable) refs.push(n.ref);
      walk(n.children);
    }
  }
  walk(state.tree);
  return refs;
}

// ---------------------------------------------------------------------------
// Compact text formatter
// ---------------------------------------------------------------------------
function formatCompactNode(node: DomTreeNode, depth = 0, opts: { filter?: string; interestingOnly?: boolean; maxDepth?: number } = {}): string {
  if (opts.maxDepth !== undefined && depth > opts.maxDepth) return '';

  const role = node.role || '';
  const name = node.name || '';

  const isInteresting = !!(
    node.name ||
    (node.role && node.role !== 'generic' && node.role !== 'none') ||
    node.interactive ||
    (node.visible && node.rect.width > 0 && node.rect.height > 0 && node.children.length === 0 && name)
  );

  if (opts.interestingOnly && !isInteresting && node.children.length === 0) return '';

  const indent = '  '.repeat(depth);
  let line = `${indent}- ${node.tag}`;
  if (role) line += `[${role}]`;
  if (name) line += ` "${name.substring(0, 100)}"`;
  line += ` [ref=${node.ref}]`;
  line += ` [x=${Math.round(node.rect.x)},y=${Math.round(node.rect.y)},w=${Math.round(node.rect.width)},h=${Math.round(node.rect.height)}]`;
  if (node.visible) line += ' [visible]';
  if (node.clickable) line += ' [clickable]';
  if (node.interactive && !node.clickable) line += ' [interactive]';
  if (Object.keys(node.attributes).length > 0) {
    const attrStr = Object.entries(node.attributes)
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(',');
    line += ` {${attrStr}}`;
  }
  line += '\n';

  let childText = '';
  for (const child of node.children) {
    childText += formatCompactNode(child, depth + 1, opts);
  }

  if (opts.interestingOnly && !isInteresting && !childText.trim()) return '';

  return line + childText;
}

export function formatCompactTree(nodes: DomTreeNode[], opts: { filter?: string; interestingOnly?: boolean; maxDepth?: number } = {}): string {
  return nodes.map((n) => formatCompactNode(n, 0, opts)).join('');
}

export function setWatching(tabId: number, watching: boolean) {
  const state = getOrCreateState(tabId);
  state.watching = watching;
}

export function isWatching(tabId: number): boolean {
  return getOrCreateState(tabId).watching;
}

export function registerDomTreeHandlers(): void {
  registerHandler('get_dom_tree', async (params, tabId) => {
    const {
      format = 'compact',
      filter,
      selector,
      interestingOnly = true,
      maxChars = 40000,
      offset = 0,
      depth = 10,
    } = params as {
      format?: 'compact' | 'json';
      filter?: string;
      selector?: string;
      interestingOnly?: boolean;
      maxChars?: number;
      offset?: number;
      depth?: number;
    };

    const state = getOrCreateState(tabId);
    let nodes = state.tree;

    // If selector provided, try to scope to matching subtree via Runtime.evaluate
    if (selector) {
      await debuggerManager.ensureAttached(tabId);
      const script = `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { error: 'Selector not found' };
        return { found: true, tag: el.tagName };
      })()`;
      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: { error?: string; found?: boolean; tag?: string } } };
      if (result.result.value?.error) {
        throw new Error(result.result.value.error);
      }
      // We don't actually prune the tree here — the compact formatter works on the full tree.
      // Future enhancement: prune tree to selector scope.
    }

    if (format === 'json') {
      const json = JSON.stringify(nodes, null, 2);
      const totalChars = json.length;
      const start = Math.max(0, Math.min(offset, totalChars));
      const end = Math.min(totalChars, start + maxChars);
      const slice = json.slice(start, end);
      const truncated = end < totalChars;
      return {
        format: 'json',
        snapshot: slice,
        totalChars,
        returnedChars: slice.length,
        offset: start,
        nextOffset: truncated ? end : null,
        truncated,
        hint: truncated
          ? `Response truncated at ${maxChars} chars. Call again with offset=${end} to continue, or pass filter="<substring>" to narrow the tree.`
          : undefined,
      };
    }

    const compact = formatCompactTree(nodes, { filter, interestingOnly, maxDepth: depth });
    const totalChars = compact.length;
    const start = Math.max(0, Math.min(offset, totalChars));
    const end = Math.min(totalChars, start + maxChars);
    const slice = compact.slice(start, end);
    const truncated = end < totalChars;

    return {
      format: 'compact',
      snapshot: slice,
      totalChars,
      returnedChars: slice.length,
      offset: start,
      nextOffset: truncated ? end : null,
      truncated,
      hint: truncated
        ? `Response truncated at ${maxChars} chars. Call again with offset=${end} to continue, or pass filter="<substring>" to narrow the tree.`
        : undefined,
    };
  });

  registerHandler('get_dom_node', async (params, tabId) => {
    const { ref } = params as { ref: string };
    const node = getDomNode(tabId, ref);
    if (!node) throw new Error(`Node not found: ${ref}`);
    return node;
  });

  registerHandler('find_dom_nodes', async (params, tabId) => {
    const { query } = params as { query: string };
    return findDomNodes(tabId, query);
  });

  registerHandler('get_dom_history', async (params, tabId) => {
    const { count = 20 } = params as { count?: number };
    return getDomHistory(tabId, count);
  });

  registerHandler('get_dom_diff', async (params, tabId) => {
    const { stepsBack = 1 } = params as { stepsBack?: number };
    const diff = getDomDiff(tabId, stepsBack);
    if (!diff) throw new Error('Not enough history for diff');
    return {
      removedCount: diff.removed.length,
      addedCount: diff.added.length,
      changedCount: diff.changed.length,
      removed: diff.removed,
      added: diff.added.map((n) => ({ ref: n.ref, tag: n.tag, role: n.role, name: n.name })),
      changed: diff.changed.map((n) => ({ ref: n.ref, tag: n.tag, role: n.role, name: n.name })),
    };
  });

  registerHandler('watch_dom', async (params, tabId) => {
    const { enable = true } = params as { enable?: boolean };
    setWatching(tabId, enable);
    return { watching: enable };
  });

  registerHandler('get_dom_clickable', async (_params, tabId) => {
    const refs = getClickableRefs(tabId);
    const state = getOrCreateState(tabId);
    const nodes = refs.map((ref) => state.refMap.get(ref)).filter(Boolean) as DomTreeNode[];
    return {
      count: nodes.length,
      nodes: nodes.map((n) => ({
        ref: n.ref,
        tag: n.tag,
        role: n.role,
        name: n.name,
        rect: n.rect,
      })),
    };
  });
}
