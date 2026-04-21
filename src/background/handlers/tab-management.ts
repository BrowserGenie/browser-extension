import { registerHandler } from '../command-router.js';

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
}
