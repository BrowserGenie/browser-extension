import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerTabManagementHandlers(): void {
  registerHandler('list_tabs', async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map((tab) => ({
      id: tab.id,
      url: tab.url,
      title: tab.title,
      active: tab.active,
      windowId: tab.windowId,
      index: tab.index,
      favIconUrl: tab.favIconUrl,
    }));
  });

  registerHandler('select_tab', async (params) => {
    const { tabId } = params as { tabId: number };
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return { tabId, activated: true };
  });

  registerHandler('new_tab', async (params) => {
    const { url } = params as { url?: string };
    const tab = await chrome.tabs.create({ url: url || undefined });
    return { tabId: tab.id, url: tab.url || tab.pendingUrl };
  });

  registerHandler('close_tab', async (params) => {
    const { tabId } = params as { tabId: number };
    await chrome.tabs.remove(tabId);
    return { tabId, closed: true };
  });

  registerHandler('get_tab_state', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);
    const tab = await chrome.tabs.get(tabId);

    const script = `(() => {
      const html = document.documentElement.outerHTML;
      let hash = 0;
      for (let i = 0; i < html.length; i++) {
        const char = html.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return {
        url: window.location.href,
        title: document.title,
        domHash: hash,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    const pageState = result.result.value as Record<string, unknown>;
    return {
      tabId: tab.id,
      url: pageState.url ?? tab.url,
      title: pageState.title ?? tab.title,
      domHash: pageState.domHash,
      scrollX: pageState.scrollX,
      scrollY: pageState.scrollY,
    };
  });

  registerHandler('assert_tabs_match', async (params) => {
    const { tabIdA, tabIdB } = params as { tabIdA: number; tabIdB: number };

    const getState = async (id: number) => {
      await debuggerManager.ensureAttached(id);
      const tab = await chrome.tabs.get(id);
      const script = `(() => {
        const html = document.documentElement.outerHTML;
        let hash = 0;
        for (let i = 0; i < html.length; i++) {
          const char = html.charCodeAt(i);
          hash = ((hash << 5) - hash) + char;
          hash = hash & hash;
        }
        return { url: window.location.href, title: document.title, domHash: hash };
      })()`;
      const result = (await debuggerManager.sendCommand(id, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: { url: string; title: string; domHash: number } } };
      return { url: result.result.value.url, title: result.result.value.title, domHash: result.result.value.domHash };
    };

    const [stateA, stateB] = await Promise.all([getState(tabIdA), getState(tabIdB)]);
    const urlsMatch = stateA.url === stateB.url;
    const titlesMatch = stateA.title === stateB.title;
    const domsMatch = stateA.domHash === stateB.domHash;

    return {
      passed: urlsMatch && titlesMatch && domsMatch,
      urlsMatch,
      titlesMatch,
      domsMatch,
      stateA,
      stateB,
    };
  });

  registerHandler('test_storage_sync', async (params) => {
    const { tabIdA, tabIdB, key, value } = params as { tabIdA: number; tabIdB: number; key: string; value: string };

    // Set localStorage in tab A
    await debuggerManager.ensureAttached(tabIdA);
    const setScript = `(() => { localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)}); return { set: true }; })()`;
    await debuggerManager.sendCommand(tabIdA, 'Runtime.evaluate', { expression: setScript, returnByValue: true });

    // Wait a moment for storage events to propagate
    await new Promise((r) => setTimeout(r, 500));

    // Check localStorage in tab B
    await debuggerManager.ensureAttached(tabIdB);
    const getScript = `(() => { return { value: localStorage.getItem(${JSON.stringify(key)}) }; })()`;
    const resultB = (await debuggerManager.sendCommand(tabIdB, 'Runtime.evaluate', {
      expression: getScript,
      returnByValue: true,
    })) as { result: { value: { value: string | null } } };

    const synced = resultB.result.value.value === value;

    return {
      synced,
      key,
      expectedValue: value,
      actualValue: resultB.result.value.value,
      message: synced ? 'localStorage synced correctly across tabs' : 'localStorage did NOT sync across tabs',
    };
  });
}
