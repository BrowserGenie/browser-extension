import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface ConsoleEntry {
  level: string;
  text: string;
  timestamp: number;
  stackTrace?: Array<{ url: string; lineNumber: number; columnNumber: number; functionName: string }>;
}

// Store console logs per tab
const consoleLogs = new Map<number, ConsoleEntry[]>();
const listeningTabs = new Set<number>();

export function getConsoleLogs(tabId: number, level?: string): ConsoleEntry[] {
  let logs = consoleLogs.get(tabId) || [];
  if (level && level !== 'all') {
    logs = logs.filter((e) => e.level === level);
  }
  return [...logs];
}

export function clearConsoleLogs(tabId: number): void {
  consoleLogs.set(tabId, []);
}

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
        stackTrace: params.stackTrace?.callFrames?.map((f: any) => ({
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber,
          functionName: f.functionName,
        })),
      });
    }

    if (method === 'Runtime.exceptionThrown') {
      const logs = consoleLogs.get(tabId);
      if (!logs) return;
      logs.push({
        level: 'error',
        text: params.exceptionDetails?.text || params.exceptionDetails?.exception?.description || 'Unknown exception',
        timestamp: params.timestamp,
        stackTrace: params.exceptionDetails?.stackTrace?.callFrames?.map((f: any) => ({
          url: f.url,
          lineNumber: f.lineNumber,
          columnNumber: f.columnNumber,
          functionName: f.functionName,
        })),
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

    await debuggerManager.ensureAttached(tabId);
    setupConsoleListeners(tabId);

    let logs = consoleLogs.get(tabId) || [];

    if (level && level !== 'all') {
      logs = logs.filter((e) => e.level === level);
    }

    const result = [...logs];

    if (clear) {
      clearConsoleLogs(tabId);
    }

    return result;
  });

  registerHandler('execute_javascript', async (params, tabId) => {
    const { expression, timeout = 28000, detach = false } = params as {
      expression: string;
      timeout?: number;
      detach?: boolean;
    };

    await debuggerManager.ensureAttached(tabId);

    // Auto-wrap in an IIFE so `const` / `let` at the top level don't pollute the
    // shared Runtime.evaluate scope and cause "Identifier already declared" on
    // the next call. Expressions that already look wrapped are left alone so
    // returning a value from a single-line expression still works.
    const trimmed = expression.trim();
    const looksWrapped =
      /^\(\s*(async\s+)?function[\s\S]*\}\s*\)\s*\(/.test(trimmed) || // (function(){...})()
      /^\(\s*(async\s*)?\(\s*\)\s*=>/.test(trimmed) ||                // (()=>...)()
      /^\{[\s\S]*\}$/.test(trimmed);                                   // bare block
    const wrappedExpr = looksWrapped
      ? trimmed
      : `(async () => {\n${trimmed}\n})()`;

    // When `detach` is requested, kick off the expression without waiting for its
    // promise — callers use this for fire-and-forget long-running work. We still
    // give the runtime enough time to schedule the microtask.
    const runWith = async (awaitPromise: boolean) => {
      return (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: wrappedExpr,
        returnByValue: true,
        generatePreview: true,
        awaitPromise,
        // Isolated world would break shared-scope patterns callers rely on; keep default.
        timeout: awaitPromise ? Math.max(1000, timeout) : 1000,
      })) as { result: { value?: unknown; description?: string; type: string; subtype?: string }; exceptionDetails?: unknown };
    };

    if (detach) {
      await runWith(false);
      return { result: null, type: 'undefined', detached: true };
    }

    // Hard wall-clock guard so the MCP round-trip never sits on a stuck evaluate.
    // If the page's own CDP-level timeout fires first it surfaces via exceptionDetails.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<'__timeout__'>((resolve) => {
      timer = setTimeout(() => resolve('__timeout__'), timeout + 2000);
    });

    try {
      const raced = await Promise.race([runWith(true), timeoutPromise]);
      if (raced === '__timeout__') {
        // Best-effort: interrupt whatever's running on that context so the next
        // call doesn't collide with a zombie evaluation.
        try {
          await debuggerManager.sendCommand(tabId, 'Runtime.terminateExecution');
        } catch { /* best-effort */ }
        return {
          result: null,
          type: 'timeout',
          error: `execute_javascript timed out after ${timeout}ms (execution was terminated)`,
        };
      }
      const result = raced as { result: { value?: unknown; description?: string; type: string; subtype?: string }; exceptionDetails?: unknown };
      return {
        result: result.result.value ?? result.result.description ?? null,
        type: result.result.type,
        subtype: result.result.subtype,
        exceptionDetails: result.exceptionDetails,
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
