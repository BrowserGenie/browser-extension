import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

const storageListeners = new Map<number, boolean>();
const cookieListenerActive = { value: false };
const cookieChanges: Array<{ cookie: { name: string; domain: string; path: string }; cause: string; removed: boolean; timestamp: number }> = [];

function ensureCookieListener(): void {
  if (cookieListenerActive.value) return;
  cookieListenerActive.value = true;
  chrome.cookies.onChanged.addListener((changeInfo) => {
    cookieChanges.push({
      cookie: {
        name: changeInfo.cookie.name,
        domain: changeInfo.cookie.domain,
        path: changeInfo.cookie.path,
      },
      cause: changeInfo.cause,
      removed: changeInfo.removed,
      timestamp: Date.now(),
    });
  });
}

export function registerMonitoringHandlers(): void {
  registerHandler('monitor_storage_events', async (params, tabId) => {
    const { action, storageType = 'both' } = params as {
      action: 'start' | 'stop' | 'get';
      storageType?: 'local' | 'session' | 'both';
    };

    if (action === 'start') {
      storageListeners.set(tabId, true);
      // Inject into all tabs of same origin for cross-tab monitoring
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.url) {
        try {
          const url = new URL(currentTab.url);
          const origin = url.origin + '/*';
          const relatedTabs = await chrome.tabs.query({ url: origin });
          for (const t of relatedTabs) {
            if (t.id && t.id !== tabId) {
              try {
                await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/storage-monitor.js'] });
              } catch {
                // Ignore injection errors on cross-origin tabs
              }
            }
          }
        } catch {
          // URL parsing error, ignore
        }
      }
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content/storage-monitor.js'] });
      return { started: true };
    }

    if (action === 'get') {
      const currentTab = await chrome.tabs.get(tabId);
      let allEvents: any[] = [];
      if (currentTab.url) {
        try {
          const url = new URL(currentTab.url);
          const origin = url.origin + '/*';
          const relatedTabs = await chrome.tabs.query({ url: origin });
          for (const t of relatedTabs) {
            if (t.id) {
              try {
                const script = `(() => {
                  const monitor = window.__browserGenieStorageMonitor;
                  return monitor ? monitor.events : [];
                })()`;
                const result = (await debuggerManager.sendCommand(t.id, 'Runtime.evaluate', {
                  expression: script,
                  returnByValue: true,
                })) as { result: { value: any[] } };
                if (result.result.value) {
                  allEvents = allEvents.concat(result.result.value.map((e) => ({ ...e, tabId: t.id })));
                }
              } catch {
                // Ignore errors on tabs not attached
              }
            }
          }
        } catch {
          // URL parsing error
        }
      }
      allEvents.sort((a, b) => a.timestamp - b.timestamp);
      return allEvents;
    }

    if (action === 'stop') {
      storageListeners.delete(tabId);
      const currentTab = await chrome.tabs.get(tabId);
      if (currentTab.url) {
        try {
          const url = new URL(currentTab.url);
          const origin = url.origin + '/*';
          const relatedTabs = await chrome.tabs.query({ url: origin });
          for (const t of relatedTabs) {
            if (t.id) {
              try {
                const script = `(() => { delete window.__browserGenieStorageMonitor; return 'stopped'; })()`;
                await debuggerManager.sendCommand(t.id, 'Runtime.evaluate', { expression: script });
              } catch {
                // Ignore
              }
            }
          }
        } catch {
          // URL parsing error
        }
      }
      return { stopped: true };
    }

    return { error: 'Unknown action' };
  });

  registerHandler('monitor_cookie_changes', async (params) => {
    const { action, domain } = params as { action: 'start' | 'stop' | 'get'; domain?: string };

    if (action === 'start') {
      ensureCookieListener();
      return { started: true };
    }

    if (action === 'get') {
      let changes = [...cookieChanges];
      if (domain) {
        changes = changes.filter((c) => c.cookie.domain.includes(domain));
      }
      return changes;
    }

    if (action === 'stop') {
      cookieChanges.length = 0;
      return { stopped: true };
    }

    return { error: 'Unknown action' };
  });

  registerHandler('monitor_console_events', async (params, tabId) => {
    const { action, levels = ['error', 'warn'] } = params as {
      action: 'start' | 'stop' | 'get';
      levels?: string[];
    };

    await debuggerManager.ensureAttached(tabId);

    if (action === 'start') {
      // Console listeners are already set up via devtools-console.ts
      return { started: true };
    }

    if (action === 'get') {
      // We need to access the console logs from devtools-console.ts
      // Since that's in a different module, we'll evaluate a script to capture new logs
      const script = `(() => {
        if (!window.__browserGenieConsoleMonitor) {
          window.__browserGenieConsoleMonitor = [];
          const origLog = console.log;
          const origWarn = console.warn;
          const origError = console.error;
          const origInfo = console.info;
          console.log = function(...args) { window.__browserGenieConsoleMonitor.push({ level: 'log', text: args.join(' '), timestamp: Date.now() }); origLog.apply(console, args); };
          console.warn = function(...args) { window.__browserGenieConsoleMonitor.push({ level: 'warn', text: args.join(' '), timestamp: Date.now() }); origWarn.apply(console, args); };
          console.error = function(...args) { window.__browserGenieConsoleMonitor.push({ level: 'error', text: args.join(' '), timestamp: Date.now() }); origError.apply(console, args); };
          console.info = function(...args) { window.__browserGenieConsoleMonitor.push({ level: 'info', text: args.join(' '), timestamp: Date.now() }); origInfo.apply(console, args); };
        }
        return window.__browserGenieConsoleMonitor;
      })()`;

      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: Array<{ level: string; text: string; timestamp: number }> } };

      const logs = result.result.value || [];
      return logs.filter((e) => levels.includes(e.level));
    }

    if (action === 'stop') {
      const script = `(() => {
        delete window.__browserGenieConsoleMonitor;
        return 'stopped';
      })()`;
      await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', { expression: script });
      return { stopped: true };
    }

    return { error: 'Unknown action' };
  });
}
