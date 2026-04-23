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
  requestBody?: string;
  timestamp: number;
  responseSize?: number;
  resourceSize?: number;
  status: 'pending' | 'complete' | 'failed';
  errorReason?: string;
  timing?: {
    dns: number;
    connect: number;
    send: number;
    receive: number;
    ssl: number;
    total: number;
  };
}

// Store network logs per tab
const networkLogs = new Map<number, NetworkEntry[]>();
const listeningTabs = new Set<number>();

export function getNetworkLogs(tabId: number): NetworkEntry[] {
  return [...(networkLogs.get(tabId) || [])];
}

export function getNetworkErrors(tabId: number): NetworkEntry[] {
  const logs = networkLogs.get(tabId) || [];
  return logs.filter(
    (e) =>
      e.status === 'failed' ||
      (e.statusCode !== undefined && (e.statusCode >= 400 || e.statusCode === 0))
  );
}

export function clearNetworkLogs(tabId: number): void {
  networkLogs.set(tabId, []);
}

function setupNetworkListeners(tabId: number): void {
  if (listeningTabs.has(tabId)) return;
  listeningTabs.add(tabId);

  if (!networkLogs.has(tabId)) {
    networkLogs.set(tabId, []);
  }

  chrome.debugger.onEvent.addListener(async (source, method, params: any) => {
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
        status: 'pending',
      });
    }

    if (method === 'Network.responseReceived') {
      const entry = logs.find((e) => e.requestId === params.requestId);
      if (entry) {
        entry.statusCode = params.response.status;
        entry.statusText = params.response.statusText;
        entry.responseHeaders = params.response.headers;
        entry.responseSize = params.response.encodedDataLength;
        const t = params.response.timing;
        if (t) {
          entry.timing = {
            dns: t.dnsEnd - t.dnsStart,
            connect: t.connectEnd - t.connectStart,
            send: t.sendEnd - t.sendStart,
            receive: t.receiveHeadersEnd - t.sendEnd,
            ssl: t.sslEnd - t.sslStart,
            total: t.receiveHeadersEnd - t.requestTime * 1000,
          };
        }
      }
    }

    if (method === 'Network.loadingFinished') {
      const entry = logs.find((e) => e.requestId === params.requestId);
      if (entry) {
        entry.status = 'complete';
        entry.resourceSize = params.encodedDataLength;
      }
    }

    if (method === 'Network.loadingFailed') {
      const entry = logs.find((e) => e.requestId === params.requestId);
      if (entry) {
        entry.status = 'failed';
        entry.errorReason = params.errorText || params.type;
      }
    }

    if (method === 'Network.requestWillBeSentExtraInfo') {
      const entry = logs.find((e) => e.requestId === params.requestId);
      if (entry && (entry.method === 'POST' || entry.method === 'PUT')) {
        try {
          const bodyResult = (await debuggerManager.sendCommand(tabId, 'Network.getRequestPostData', {
            requestId: params.requestId,
          })) as { postData?: string };
          if (bodyResult.postData) {
            entry.requestBody = bodyResult.postData;
          }
        } catch {
          // Post data may not be available
        }
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

export function ensureNetworkListeners(tabId: number): void {
  setupNetworkListeners(tabId);
}

export function registerDevtoolsNetworkHandlers(): void {
  registerHandler('get_network_logs', async (params, tabId) => {
    const { filter } = params as {
      filter?: { urlPattern?: string; method?: string; statusCode?: number; resourceType?: string };
    };

    await debuggerManager.ensureAttached(tabId);
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
    await debuggerManager.ensureAttached(tabId);

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
