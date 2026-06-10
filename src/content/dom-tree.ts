(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Types
  // ---------------------------------------------------------------------------
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
    type: 'full' | 'delta';
    timestamp: number;
    nodes?: DomTreeNode[];
    changed?: DomTreeNode[];
    removed?: string[];
  }

  // ---------------------------------------------------------------------------
  // Ref generation
  // ---------------------------------------------------------------------------
  let refCounter = 0;
  const refMap = new WeakMap<Element, string>();

  function getRef(el: Element): string {
    let ref = refMap.get(el);
    if (!ref) {
      ref = `e${++refCounter}`;
      refMap.set(el, ref);
    }
    return ref;
  }

  // ---------------------------------------------------------------------------
  // Event listener tracking (monkey-patch)
  // ---------------------------------------------------------------------------
  const eventRegistry = new WeakMap<Element, Set<string>>();

  const origAddEventListener = Element.prototype.addEventListener;
  const origRemoveEventListener = Element.prototype.removeEventListener;

  Element.prototype.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (listener) {
      const set = eventRegistry.get(this) || new Set<string>();
      set.add(type);
      eventRegistry.set(this, set);
    }
    return origAddEventListener.call(this, type, listener!, options);
  };

  Element.prototype.removeEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | EventListenerOptions
  ) {
    if (listener) {
      const set = eventRegistry.get(this);
      if (set) {
        set.delete(type);
        if (set.size === 0) eventRegistry.delete(this);
      }
    }
    return origRemoveEventListener.call(this, type, listener!, options);
  };

  // ---------------------------------------------------------------------------
  // Semantic role mapping
  // ---------------------------------------------------------------------------
  function getRole(el: Element): string | undefined {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;

    const tag = el.tagName.toLowerCase();
    const semanticMap: Record<string, string> = {
      button: 'button',
      a: 'link',
      input: (el as HTMLInputElement).type || 'textbox',
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
      h1: 'heading',
      h2: 'heading',
      h3: 'heading',
      h4: 'heading',
      h5: 'heading',
      h6: 'heading',
      table: 'table',
      form: 'form',
      img: 'img',
    };

    if (tag === 'input') {
      const inputType = (el as HTMLInputElement).type;
      if (inputType === 'checkbox') return 'checkbox';
      if (inputType === 'radio') return 'radio';
      if (inputType === 'submit' || inputType === 'button' || inputType === 'reset') return 'button';
      if (inputType === 'text' || inputType === 'email' || inputType === 'password' || inputType === 'search' || inputType === 'url') return 'textbox';
      return 'textbox';
    }

    return semanticMap[tag];
  }

  // ---------------------------------------------------------------------------
  // Name extraction
  // ---------------------------------------------------------------------------
  function getName(el: Element): string | undefined {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return ariaLabel;

    const ariaLabelledBy = el.getAttribute('aria-labelledby');
    if (ariaLabelledBy) {
      const labelEl = document.getElementById(ariaLabelledBy);
      if (labelEl) return (labelEl.textContent || '').trim();
    }

    const title = el.getAttribute('title');
    if (title) return title;

    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder;

    // For form controls, try associated label
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) return (label.textContent || '').trim();
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return (parentLabel.textContent || '').trim();
    }

    // Text content for leaf nodes (but not for containers)
    if (el.children.length === 0) {
      const text = (el.textContent || '').trim();
      if (text && text.length <= 200) return text;
    }

    return undefined;
  }

  // ---------------------------------------------------------------------------
  // Interesting check (for filtering)
  // ---------------------------------------------------------------------------
  function isInteresting(el: Element, node: DomTreeNode): boolean {
    if (node.name) return true;
    if (node.role && node.role !== 'generic' && node.role !== 'none') return true;
    if (node.interactive) return true;
    if (node.visible && node.rect.width > 0 && node.rect.height > 0) {
      // Visible leaf elements with text
      if (el.children.length === 0 && (el.textContent || '').trim()) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Build node from element
  // ---------------------------------------------------------------------------
  function buildNode(el: Element, depth: number, maxDepth: number): DomTreeNode | null {
    if (depth > maxDepth) return null;

    const tag = el.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template') return null;

    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    const visible =
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      parseFloat(style.opacity) > 0.01;

    const events = eventRegistry.get(el);
    const hasClickListener = events ? events.has('click') || events.has('mousedown') || events.has('mouseup') : false;
    const isInteractiveTag = ['button', 'a', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag);
    const hasOnClick = el.hasAttribute('onclick');
    const interactive = isInteractiveTag || hasClickListener || hasOnClick || el.getAttribute('tabindex') === '0';

    const role = getRole(el);
    const name = getName(el);

    // Collect filtered attributes
    const attributes: Record<string, string> = {};
    const attrWhitelist = ['id', 'class', 'href', 'src', 'type', 'name', 'placeholder', 'value', 'alt', 'title', 'for', 'action', 'method'];
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes[i];
      if (attrWhitelist.includes(attr.name) || attr.name.startsWith('aria-') || attr.name.startsWith('data-')) {
        attributes[attr.name] = attr.value;
      }
    }

    // Collect filtered styles
    const styles: Record<string, string> = {};
    const styleProps = ['display', 'visibility', 'opacity', 'pointer-events', 'z-index', 'position', 'top', 'left', 'width', 'height'];
    for (const prop of styleProps) {
      const val = style.getPropertyValue(prop);
      if (val && val !== 'auto' && val !== 'normal' && val !== 'static') {
        styles[prop] = val;
      }
    }

    const node: DomTreeNode = {
      ref: getRef(el),
      tag,
      role,
      name,
      id: el.id || undefined,
      className: (el.className && typeof el.className === 'string') ? el.className : undefined,
      attributes,
      styles,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visible,
      interactive,
      clickable: false, // computed later
      children: [],
      events: events ? Array.from(events) : undefined,
    };

    // Build children
    for (let i = 0; i < el.children.length; i++) {
      const child = el.children[i];
      const childNode = buildNode(child, depth + 1, maxDepth);
      if (childNode) node.children.push(childNode);
    }

    return node;
  }

  // ---------------------------------------------------------------------------
  // Compute clickable (top-layer) status
  // ---------------------------------------------------------------------------
  function computeClickable(nodes: DomTreeNode[], rootEl: Element) {
    // Build flat map
    const flat = new Map<string, { node: DomTreeNode; el: Element }>();
    const elToRef = new WeakMap<Element, string>();

    function walk(node: DomTreeNode, el: Element) {
      flat.set(node.ref, { node, el });
      elToRef.set(el, node.ref);
      for (let i = 0; i < node.children.length && i < el.children.length; i++) {
        walk(node.children[i], el.children[i]);
      }
    }

    // We need to walk the real DOM in parallel with the tree
    // Since tree was built from DOM, indices match
    function parallelWalk(node: DomTreeNode, el: Element) {
      flat.set(node.ref, { node, el });
      elToRef.set(el, node.ref);
      const childEls = Array.from(el.children).filter(c => {
        const t = c.tagName.toLowerCase();
        return t !== 'script' && t !== 'style' && t !== 'noscript' && t !== 'template';
      });
      for (let i = 0; i < node.children.length && i < childEls.length; i++) {
        parallelWalk(node.children[i], childEls[i]);
      }
    }

    if (nodes.length > 0 && rootEl) {
      const childEls = Array.from(rootEl.children).filter(c => {
        const t = c.tagName.toLowerCase();
        return t !== 'script' && t !== 'style' && t !== 'noscript' && t !== 'template';
      });
      for (let i = 0; i < nodes.length && i < childEls.length; i++) {
        parallelWalk(nodes[i], childEls[i]);
      }
    }

    // For each visible interactive element, check if elementFromPoint returns it
    for (const [ref, { node, el }] of flat) {
      if (!node.visible || !node.interactive) {
        node.clickable = false;
        continue;
      }

      const r = node.rect;
      if (r.width <= 0 || r.height <= 0) {
        node.clickable = false;
        continue;
      }

      // Check center point
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;

      // Skip if outside viewport
      if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
        node.clickable = false;
        continue;
      }

      try {
        const topEl = document.elementFromPoint(cx, cy);
        if (!topEl) {
          node.clickable = false;
          continue;
        }

        // Check if topEl is this element or a descendant/ancestor
        let match = topEl === el;
        if (!match) {
          match = el.contains(topEl) || topEl.contains(el);
        }
        node.clickable = match;
      } catch {
        node.clickable = false;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Build full tree
  // ---------------------------------------------------------------------------
  function buildTree(maxDepth = 10): DomTreeNode[] {
    const body = document.body;
    if (!body) return [];

    const nodes: DomTreeNode[] = [];
    const childEls = Array.from(body.children).filter(c => {
      const t = c.tagName.toLowerCase();
      return t !== 'script' && t !== 'style' && t !== 'noscript' && t !== 'template';
    });

    for (const el of childEls) {
      const node = buildNode(el, 0, maxDepth);
      if (node) nodes.push(node);
    }

    computeClickable(nodes, body);
    return nodes;
  }

  // ---------------------------------------------------------------------------
  // Delta computation
  // ---------------------------------------------------------------------------
  function hashNode(node: DomTreeNode): string {
    const parts = [
      node.tag,
      node.role || '',
      node.name || '',
      node.visible ? 'v' : 'h',
      node.clickable ? 'c' : 'n',
      node.interactive ? 'i' : 'p',
      `${Math.round(node.rect.x)},${Math.round(node.rect.y)},${Math.round(node.rect.width)},${Math.round(node.rect.height)}`,
      JSON.stringify(node.attributes),
      JSON.stringify(node.styles),
    ];
    return parts.join('|');
  }

  function computeDelta(oldNodes: DomTreeNode[], newNodes: DomTreeNode[]): { changed: DomTreeNode[]; removed: string[] } {
    const oldMap = new Map<string, DomTreeNode>();
    function indexOld(nodes: DomTreeNode[]) {
      for (const n of nodes) {
        oldMap.set(n.ref, n);
        indexOld(n.children);
      }
    }
    indexOld(oldNodes);

    const changed: DomTreeNode[] = [];
    const removed: string[] = [];
    const seen = new Set<string>();

    function walkNew(nodes: DomTreeNode[]) {
      for (const n of nodes) {
        seen.add(n.ref);
        const old = oldMap.get(n.ref);
        if (!old) {
          changed.push(n); // new node
        } else if (hashNode(n) !== hashNode(old)) {
          changed.push(n);
        }
        walkNew(n.children);
      }
    }
    walkNew(newNodes);

    for (const [ref] of oldMap) {
      if (!seen.has(ref)) removed.push(ref);
    }

    return { changed, removed };
  }

  // ---------------------------------------------------------------------------
  // Send delta to service worker
  // ---------------------------------------------------------------------------
  let lastTree: DomTreeNode[] | null = null;
  let pendingSend = false;

  function sendTree(type: 'full' | 'delta') {
    const newTree = buildTree(10);

    let payload: DomTreeDelta;
    if (type === 'full' || !lastTree) {
      payload = {
        tabId: -1, // SW will fill in from sender.tab.id
        type: 'full',
        timestamp: Date.now(),
        nodes: newTree,
      };
    } else {
      const { changed, removed } = computeDelta(lastTree, newTree);
      if (changed.length === 0 && removed.length === 0) {
        lastTree = newTree;
        return; // no change
      }
      payload = {
        tabId: -1,
        type: 'delta',
        timestamp: Date.now(),
        changed,
        removed,
      };
    }

    lastTree = newTree;

    try {
      chrome.runtime.sendMessage({ type: 'dom-tree-update', payload });
    } catch {
      // Extension context may be invalidated on navigation
    }
  }

  function scheduleSend(type: 'full' | 'delta') {
    if (pendingSend) return;
    pendingSend = true;
    setTimeout(() => {
      pendingSend = false;
      sendTree(type);
    }, 100);
  }

  // ---------------------------------------------------------------------------
  // Observers
  // ---------------------------------------------------------------------------
  const mutationObserver = new MutationObserver((mutations) => {
    let hasStructural = false;
    for (const m of mutations) {
      if (m.type === 'childList') {
        hasStructural = true;
        break;
      }
    }
    scheduleSend(hasStructural ? 'full' : 'delta');
  });

  const intersectionObserver = new IntersectionObserver(
    (entries) => {
      let changed = false;
      for (const entry of entries) {
        const el = entry.target as Element;
        const ref = refMap.get(el);
        if (ref && lastTree) {
          // We can't easily update the tree in-place from here, so just schedule a delta
          changed = true;
        }
      }
      if (changed) scheduleSend('delta');
    },
    { threshold: [0, 0.5, 1] }
  );

  const resizeObserver = new ResizeObserver((entries) => {
    if (entries.length > 0) scheduleSend('delta');
  });

  // ---------------------------------------------------------------------------
  // Observe all current and future elements
  // ---------------------------------------------------------------------------
  function observeElement(el: Element) {
    try {
      intersectionObserver.observe(el);
      resizeObserver.observe(el);
    } catch {
      // Some elements can't be observed
    }
  }

  function observeAll(root: Element = document.body) {
    if (!root) return;
    observeElement(root);
    const all = root.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      observeElement(all[i]);
    }
  }

  // ---------------------------------------------------------------------------
  // Re-observe after mutations
  // ---------------------------------------------------------------------------
  const mutationObserverForObserve = new MutationObserver((mutations) => {
    for (let mIdx = 0; mIdx < mutations.length; mIdx++) {
      const m = mutations[mIdx];
      for (let nIdx = 0; nIdx < m.addedNodes.length; nIdx++) {
        const node = m.addedNodes[nIdx];
        if (node instanceof Element) {
          observeElement(node);
          if (node.children.length > 0) {
            const all = node.querySelectorAll('*');
            for (let i = 0; i < all.length; i++) {
              observeElement(all[i]);
            }
          }
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  function init() {
    if (!document.body) {
      setTimeout(init, 50);
      return;
    }

    // Start observing
    observeAll();

    mutationObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'aria-expanded', 'aria-selected'],
    });

    mutationObserverForObserve.observe(document.body, {
      childList: true,
      subtree: true,
    });

    // Send initial full tree
    sendTree('full');

    // Re-send on visibility change (may affect visibility state)
    document.addEventListener('visibilitychange', () => {
      scheduleSend('full');
    });

    // Re-send on scroll (affects elementFromPoint for clickable check)
    let scrollTimeout: ReturnType<typeof setTimeout> | null = null;
    window.addEventListener('scroll', () => {
      if (scrollTimeout) clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => scheduleSend('delta'), 150);
    }, { passive: true });

    // Re-send on resize
    window.addEventListener('resize', () => {
      scheduleSend('full');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
