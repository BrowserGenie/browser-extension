import { CommandRequest, CommandResponse } from '../shared/types.js';
import { getApiKey, getBlocklist, getFeatureToggles } from '../shared/storage.js';
import { isUrlBlocked } from './blocklist.js';
import { wsClient } from './websocket-client.js';

// Feature category mapping
const COMMAND_CATEGORIES: Record<string, string> = {
  navigate_to_url: 'navigation', navigate_back: 'navigation', navigate_forward: 'navigation', navigate_reload: 'navigation',
  list_tabs: 'tabs', select_tab: 'tabs', new_tab: 'tabs', close_tab: 'tabs',
  press_key: 'keyboard', type_text: 'keyboard',
  click_element: 'interaction', input_and_type: 'interaction', drag_and_drop: 'interaction', hover_element: 'interaction',
  screenshot_viewport: 'screenshots', screenshot_full_page: 'screenshots',

  read_page_html: 'devtools_sources', read_stylesheets: 'devtools_sources', read_scripts: 'devtools_sources', read_page_resources: 'devtools_sources',
  modify_html: 'devtools_modify', modify_css: 'devtools_modify',
  get_network_logs: 'devtools_network', get_network_request_detail: 'devtools_network', clear_network_logs: 'devtools_network',
  get_cookies: 'devtools_storage', set_cookie: 'devtools_storage', delete_cookie: 'devtools_storage',
  get_local_storage: 'devtools_storage', set_local_storage: 'devtools_storage', remove_local_storage: 'devtools_storage',
  get_session_storage: 'devtools_storage', set_session_storage: 'devtools_storage', remove_session_storage: 'devtools_storage',
  get_console_logs: 'devtools_console', execute_javascript: 'devtools_console',
};

type CommandHandler = (params: Record<string, unknown>, tabId: number) => Promise<unknown>;
const handlers = new Map<string, CommandHandler>();

export function registerHandler(command: string, handler: CommandHandler): void {
  handlers.set(command, handler);
}

function sendResponse(requestId: string, success: boolean, data?: unknown, error?: { code: string; message: string }): void {
  const response: CommandResponse = {
    id: crypto.randomUUID(),
    type: 'response',
    requestId,
    success,
    data,
    error,
    timestamp: Date.now(),
  };
  wsClient.send(response);
}

export async function resolveTabId(tabId?: number): Promise<number> {
  if (tabId !== undefined) {
    const tab = await chrome.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} not found`);
    return tabId;
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No active tab found');
  return tab.id;
}

export async function handleCommand(request: CommandRequest): Promise<void> {
  const { id, command, params, apiKey } = request;

  try {
    // 1. Auth check
    const storedKey = await getApiKey();
    if (storedKey && storedKey !== apiKey) {
      sendResponse(id, false, undefined, {
        code: 'AUTH_FAILED',
        message: 'Invalid API key',
      });
      return;
    }

    // 2. Feature toggle check
    const category = COMMAND_CATEGORIES[command];
    if (category) {
      const toggles = await getFeatureToggles();
      if (toggles[category] === false) {
        sendResponse(id, false, undefined, {
          code: 'FEATURE_DISABLED',
          message: `Feature category "${category}" is disabled`,
        });
        return;
      }
    }

    // 3. Resolve tab and check blocklist (for tab-specific commands)
    let tabId: number | undefined;
    const tabCommands = new Set(['list_tabs', 'new_tab']); // Commands that don't need a specific tab
    if (!tabCommands.has(command)) {
      tabId = await resolveTabId(request.tabId);
      const tab = await chrome.tabs.get(tabId);
      const blocklist = await getBlocklist();
      if (tab.url && isUrlBlocked(tab.url, blocklist)) {
        sendResponse(id, false, undefined, {
          code: 'URL_BLOCKED',
          message: `Extension is blocked on this URL: ${tab.url}`,
        });
        return;
      }
    }

    // 4. Dispatch to handler
    const handler = handlers.get(command);
    if (!handler) {
      sendResponse(id, false, undefined, {
        code: 'UNKNOWN_COMMAND',
        message: `Unknown command: ${command}`,
      });
      return;
    }

    const result = await handler(params, tabId!);
    sendResponse(id, true, result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    sendResponse(id, false, undefined, {
      code: 'EXECUTION_ERROR',
      message,
    });
  }
}
