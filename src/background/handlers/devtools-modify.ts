import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerDevtoolsModifyHandlers(): void {
  registerHandler('modify_html', async (params, tabId) => {
    const { selector, action, value, attributeName } = params as {
      selector: string;
      action: 'setOuterHTML' | 'setInnerHTML' | 'setAttribute' | 'removeAttribute' | 'removeNode';
      value?: string;
      attributeName?: string;
    };

    await debuggerManager.enableDomain(tabId, 'DOM');

    // Find node by selector
    const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument', { depth: 0 })) as {
      root: { nodeId: number };
    };
    const searchResult = (await debuggerManager.sendCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    })) as { nodeId: number };

    if (!searchResult.nodeId) {
      throw new Error(`Element not found: ${selector}`);
    }

    const nodeId = searchResult.nodeId;

    switch (action) {
      case 'setOuterHTML':
        await debuggerManager.sendCommand(tabId, 'DOM.setOuterHTML', { nodeId, outerHTML: value });
        break;
      case 'setInnerHTML':
        // Use Runtime.evaluate for innerHTML
        await debuggerManager.enableDomain(tabId, 'Runtime');
        await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
          expression: `document.querySelector(${JSON.stringify(selector)}).innerHTML = ${JSON.stringify(value)}`,
        });
        break;
      case 'setAttribute':
        if (!attributeName) throw new Error('attributeName is required for setAttribute');
        await debuggerManager.sendCommand(tabId, 'DOM.setAttributeValue', {
          nodeId, name: attributeName, value: value || '',
        });
        break;
      case 'removeAttribute':
        if (!attributeName) throw new Error('attributeName is required for removeAttribute');
        await debuggerManager.sendCommand(tabId, 'DOM.removeAttribute', {
          nodeId, name: attributeName,
        });
        break;
      case 'removeNode':
        await debuggerManager.sendCommand(tabId, 'DOM.removeNode', { nodeId });
        break;
    }

    return { selector, action, success: true };
  });

  registerHandler('modify_css', async (params, tabId) => {
    const { selector, styles } = params as { selector: string; styles: Record<string, string> };

    await debuggerManager.enableDomain(tabId, 'Runtime');

    const styleEntries = Object.entries(styles)
      .map(([prop, val]) => `el.style[${JSON.stringify(prop)}] = ${JSON.stringify(val)}`)
      .join('; ');

    const script = `(() => {
      const elements = document.querySelectorAll(${JSON.stringify(selector)});
      if (elements.length === 0) return { error: 'No elements found' };
      elements.forEach(el => { ${styleEntries} });
      return { modified: elements.length };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: { error?: string; modified?: number } } };

    if (result.result.value?.error) {
      throw new Error(result.result.value.error);
    }

    return { selector, stylesApplied: Object.keys(styles).length, elementsModified: result.result.value?.modified };
  });
}
