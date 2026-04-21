import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
  url?: string;
  lineNumber?: number;
}

// Store console logs per tab
const consoleLogs = new Map<number, ConsoleEntry[]>();
const listeningTabs = new Set<number>();

function setupConsoleListeners(tabId: number): void {
  if (listeningTabs.has(tabId)) return;
  listeningTabs.add(tabId);

  if (!consoleLogs.has(tabId)) {
    consoleLogs.set(tabId, []);
  }

  chrome.debugger.onEvent.addListener((source, method, params: any) => {
    if (source.tabId !== tabId) return;

    if (method === 'Runtime.consoleAPICalled') {
      const logs = consoleLogs.get(tabId);
      if (!logs) return;
      const args = (params.args || []).map((arg: any) => {
        if (arg.type === 'string') return arg.value;
        if (arg.type === 'number') return arg.value;
        if (arg.type === 'boolean') return arg.value;
        if (arg.type === 'undefined') return 'undefined';
        if (arg.subtype === 'null') return 'null';
        if (arg.description) return arg.description;
        if (arg.preview?.description) return arg.preview.description;
        return JSON.stringify(arg.value ?? arg);
      });
      logs.push({
        level: params.type,
        text: args.join(' '),
        timestamp: params.timestamp,
        url: params.stackTrace?.callFrames?.[0]?.url,
        lineNumber: params.stackTrace?.callFrames?.[0]?.lineNumber,
      });
    }

    if (method === 'Runtime.exceptionThrown') {
      const logs = consoleLogs.get(tabId);
      if (!logs) return;
      logs.push({
        level: 'error',
        text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Unknown exception',
        timestamp: params.timestamp,
        url: params.exceptionDetails?.url,
        lineNumber: params.exceptionDetails?.lineNumber,
      });
    }
  });

  chrome.tabs.onRemoved.addListener((removedTabId) => {
    if (removedTabId === tabId) {
      consoleLogs.delete(tabId);
      listeningTabs.delete(tabId);
    }
  });
}

export function registerDevtoolsConsoleHandlers(): void {
  registerHandler('get_console_logs', async (params, tabId) => {
    const { level, clear } = params as { level?: string; clear?: boolean };

    await debuggerManager.enableDomain(tabId, 'Runtime');
    setupConsoleListeners(tabId);

    let logs = consoleLogs.get(tabId) || [];

    if (level && level !== 'all') {
      logs = logs.filter((e) => e.level === level);
    }

    const result = [...logs];

    if (clear) {
      consoleLogs.set(tabId, []);
    }

    return result;
  });

  registerHandler('execute_javascript', async (params, tabId) => {
    const { expression } = params as { expression: string };

    await debuggerManager.enableDomain(tabId, 'Runtime');

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      generatePreview: true,
      awaitPromise: true,
    })) as { result: { value?: unknown; description?: string; type: string; subtype?: string }; exceptionDetails?: unknown };

    return {
      result: result.result.value ?? result.result.description ?? null,
      type: result.result.type,
      subtype: result.result.subtype,
      exceptionDetails: result.exceptionDetails,
    };
  });
}
