import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  statusCode?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  timestamp: number;
  responseSize?: number;
}

// Store network logs per tab
const networkLogs = new Map<number, NetworkEntry[]>();
const listeningTabs = new Set<number>();

function setupNetworkListeners(tabId: number): void {
  if (listeningTabs.has(tabId)) return;
  listeningTabs.add(tabId);

  if (!networkLogs.has(tabId)) {
    networkLogs.set(tabId, []);
  }

  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    if (source.tabId !== tabId) return;

    const logs = networkLogs.get(tabId);
    if (!logs) return;

    if (method === 'Network.requestWillBeSent') {
      logs.push({
        requestId: params.requestId,
        url: params.request.url,
        method: params.request.method,
        resourceType: params.type || 'Other',
        requestHeaders: params.request.headers,
        timestamp: params.timestamp,
      });
    }

    if (method === 'Network.responseReceived') {
      const entry = logs.find((e) => e.requestId === params.requestId);
      if (entry) {
        entry.statusCode = params.response.status;
        entry.statusText = params.response.statusText;
        entry.responseHeaders = params.response.headers;
        entry.responseSize = params.response.encodedDataLength;
      }
    }
  });

  chrome.tabs.onRemoved.addListener((removedTabId) => {
    if (removedTabId === tabId) {
      networkLogs.delete(tabId);
      listeningTabs.delete(tabId);
    }
  });
}

export function registerDevtoolsNetworkHandlers(): void {
  registerHandler('get_network_logs', async (params, tabId) => {
    const { filter } = params as {
      filter?: { urlPattern?: string; method?: string; statusCode?: number; resourceType?: string };
    };

    await debuggerManager.enableDomain(tabId, 'Network');
    setupNetworkListeners(tabId);

    let logs = networkLogs.get(tabId) || [];

    if (filter) {
      if (filter.urlPattern) {
        const pattern = filter.urlPattern.toLowerCase();
        logs = logs.filter((e) => e.url.toLowerCase().includes(pattern));
      }
      if (filter.method) {
        logs = logs.filter((e) => e.method.toUpperCase() === filter.method!.toUpperCase());
      }
      if (filter.statusCode !== undefined) {
        logs = logs.filter((e) => e.statusCode === filter.statusCode);
      }
      if (filter.resourceType) {
        logs = logs.filter((e) => e.resourceType.toLowerCase() === filter.resourceType!.toLowerCase());
      }
    }

    return logs;
  });

  registerHandler('get_network_request_detail', async (params, tabId) => {
    const { requestId, includeBody = false } = params as { requestId: string; includeBody?: boolean };
    await debuggerManager.enableDomain(tabId, 'Network');

    const logs = networkLogs.get(tabId) || [];
    const entry = logs.find((e) => e.requestId === requestId);
    if (!entry) throw new Error(`Request not found: ${requestId}`);

    const detail: Record<string, unknown> = { ...entry };

    if (includeBody) {
      try {
        const bodyResult = (await debuggerManager.sendCommand(tabId, 'Network.getResponseBody', {
          requestId,
        })) as { body: string; base64Encoded: boolean };
        detail.responseBody = bodyResult.body;
        detail.bodyBase64Encoded = bodyResult.base64Encoded;
      } catch {
        detail.responseBody = '[Could not retrieve body]';
      }
    }

    return detail;
  });

  registerHandler('clear_network_logs', async (_params, tabId) => {
    networkLogs.set(tabId, []);
    return { cleared: true };
  });
}
