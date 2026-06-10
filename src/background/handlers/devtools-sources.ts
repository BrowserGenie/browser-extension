import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerDevtoolsSourcesHandlers(): void {
  registerHandler('read_page_html', async (_params, tabId) => {
    await debuggerManager.enableDomain(tabId, 'DOM');
    const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument', { depth: -1 })) as {
      root: { nodeId: number };
    };
    const result = (await debuggerManager.sendCommand(tabId, 'DOM.getOuterHTML', {
      nodeId: doc.root.nodeId,
    })) as { outerHTML: string };
    return result.outerHTML;
  });

  registerHandler('read_stylesheets', async (params, tabId) => {
    const { url } = params as { url?: string };
    await debuggerManager.enableDomain(tabId, 'CSS');

    // Get all stylesheet headers
    const allSheets: Array<{ styleSheetId: string; sourceURL: string; title: string; text?: string }> = [];

    // Listen for stylesheet events
    const sheetsResult = (await debuggerManager.sendCommand(tabId, 'CSS.getStyleSheetText', {})) as any;

    // Alternative: use Page.getResourceTree
    await debuggerManager.enableDomain(tabId, 'Page');
    const tree = (await debuggerManager.sendCommand(tabId, 'Page.getResourceTree')) as {
      frameTree: { resources: Array<{ url: string; type: string; mimeType: string }> };
    };

    const stylesheets = tree.frameTree.resources.filter(
      (r) => r.type === 'Stylesheet' || r.mimeType === 'text/css'
    );

    if (url) {
      const target = stylesheets.find((s) => s.url === url || s.url.includes(url));
      if (!target) throw new Error(`Stylesheet not found: ${url}`);
      const content = (await debuggerManager.sendCommand(tabId, 'Page.getResourceContent', {
        frameId: (await getMainFrameId(tabId)),
        url: target.url,
      })) as { content: string; base64Encoded: boolean };
      return [{ url: target.url, content: content.content }];
    }

    const results = [];
    for (const sheet of stylesheets) {
      try {
        const frameId = await getMainFrameId(tabId);
        const content = (await debuggerManager.sendCommand(tabId, 'Page.getResourceContent', {
          frameId,
          url: sheet.url,
        })) as { content: string; base64Encoded: boolean };
        results.push({ url: sheet.url, content: content.content });
      } catch {
        results.push({ url: sheet.url, content: '[Error reading stylesheet]' });
      }
    }
    return results;
  });

  registerHandler('read_scripts', async (params, tabId) => {
    const { url } = params as { url?: string };
    await debuggerManager.enableDomain(tabId, 'Page');

    const tree = (await debuggerManager.sendCommand(tabId, 'Page.getResourceTree')) as {
      frameTree: { frame: { id: string }; resources: Array<{ url: string; type: string; mimeType: string }> };
    };

    const scripts = tree.frameTree.resources.filter(
      (r) => r.type === 'Script' || r.mimeType === 'application/javascript' || r.mimeType === 'text/javascript'
    );

    const frameId = tree.frameTree.frame.id;

    if (url) {
      const target = scripts.find((s) => s.url === url || s.url.includes(url));
      if (!target) throw new Error(`Script not found: ${url}`);
      const content = (await debuggerManager.sendCommand(tabId, 'Page.getResourceContent', {
        frameId, url: target.url,
      })) as { content: string; base64Encoded: boolean };
      return [{ url: target.url, content: content.content }];
    }

    const results = [];
    for (const script of scripts) {
      try {
        const content = (await debuggerManager.sendCommand(tabId, 'Page.getResourceContent', {
          frameId, url: script.url,
        })) as { content: string; base64Encoded: boolean };
        results.push({ url: script.url, content: content.content });
      } catch {
        results.push({ url: script.url, content: '[Error reading script]' });
      }
    }
    return results;
  });

  registerHandler('read_page_resources', async (params, tabId) => {
    const { type } = params as { type?: string };
    await debuggerManager.enableDomain(tabId, 'Page');

    const tree = (await debuggerManager.sendCommand(tabId, 'Page.getResourceTree')) as {
      frameTree: { resources: Array<{ url: string; type: string; mimeType: string; contentSize?: number }> };
    };

    let resources = tree.frameTree.resources;
    if (type && type !== 'all') {
      const typeMap: Record<string, string[]> = {
        image: ['Image'],
        font: ['Font'],
        stylesheet: ['Stylesheet'],
        script: ['Script'],
      };
      const types = typeMap[type] || [type];
      resources = resources.filter((r) => types.includes(r.type));
    }

    return resources.map((r) => ({
      url: r.url,
      type: r.type,
      mimeType: r.mimeType,
      contentSize: r.contentSize,
    }));
  });

  registerHandler('find_in_source', async (params, tabId) => {
    const { pattern, contextLines = 2 } = params as { pattern: string; contextLines?: number };
    await debuggerManager.ensureAttached(tabId);

    // Get page HTML via CDP DOM domain (no JS injection)
    await debuggerManager.enableDomain(tabId, 'DOM');
    const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument', { depth: -1 })) as {
      root: { nodeId: number };
    };
    const outerHtmlResult = (await debuggerManager.sendCommand(tabId, 'DOM.getOuterHTML', {
      nodeId: doc.root.nodeId,
    })) as { outerHTML: string };
    const html = outerHtmlResult.outerHTML || '';

    // Get script sources via CDP Page domain
    await debuggerManager.enableDomain(tabId, 'Page');
    const tree = (await debuggerManager.sendCommand(tabId, 'Page.getResourceTree')) as {
      frameTree: { frame: { id: string }; resources: Array<{ url: string; type: string; mimeType: string }> };
    };
    const scripts = tree.frameTree.resources.filter(
      (r) => r.type === 'Script' || r.mimeType === 'application/javascript' || r.mimeType === 'text/javascript'
    );

    const regex = new RegExp(pattern, 'gi');
    const matches: Array<{ source: string; url: string; line: number; context: string; match: string }> = [];

    function searchInText(text: string, url: string) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        let m;
        regex.lastIndex = 0;
        while ((m = regex.exec(line)) !== null) {
          const start = Math.max(0, i - contextLines);
          const end = Math.min(lines.length, i + contextLines + 1);
          const context = lines.slice(start, end).join('\n');
          matches.push({
            source: url === '__html__' ? 'HTML' : 'Script',
            url,
            line: i + 1,
            context,
            match: m[0],
          });
        }
      }
    }

    searchInText(html, '__html__');

    const frameId = tree.frameTree.frame.id;
    for (const script of scripts) {
      try {
        const content = (await debuggerManager.sendCommand(tabId, 'Page.getResourceContent', {
          frameId, url: script.url,
        })) as { content: string };
        searchInText(content.content, script.url);
      } catch {
        // Skip unreadable scripts
      }
    }

    return { pattern, matchCount: matches.length, matches: matches.slice(0, 100) };
  });
}

async function getMainFrameId(tabId: number): Promise<string> {
  await debuggerManager.enableDomain(tabId, 'Page');
  const tree = (await debuggerManager.sendCommand(tabId, 'Page.getResourceTree')) as {
    frameTree: { frame: { id: string } };
  };
  return tree.frameTree.frame.id;
}
