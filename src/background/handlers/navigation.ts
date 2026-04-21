import { registerHandler } from '../command-router.js';

export function registerNavigationHandlers(): void {
  registerHandler('navigate_to_url', async (params, tabId) => {
    const { url } = params as { url: string };
    await chrome.tabs.update(tabId, { url });
    // Wait for page to start loading
    return new Promise((resolve) => {
      const listener = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
        if (updatedTabId === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve({ url, status: 'complete' });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      // Timeout fallback
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve({ url, status: 'navigating' });
      }, 30000);
    });
  });

  registerHandler('navigate_back', async (_params, tabId) => {
    await chrome.tabs.goBack(tabId);
    return { action: 'back' };
  });

  registerHandler('navigate_forward', async (_params, tabId) => {
    await chrome.tabs.goForward(tabId);
    return { action: 'forward' };
  });

  registerHandler('navigate_reload', async (params, tabId) => {
    const { ignoreCache } = params as { ignoreCache?: boolean };
    await chrome.tabs.reload(tabId, { bypassCache: ignoreCache });
    return { action: 'reload', bypassCache: !!ignoreCache };
  });
}
