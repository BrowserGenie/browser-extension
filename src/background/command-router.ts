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
  screenshot_viewport: 'screenshots', screenshot_full_page: 'screenshots', screenshot_element: 'screenshots',

  read_page_html: 'devtools_sources', read_stylesheets: 'devtools_sources', read_scripts: 'devtools_sources', read_page_resources: 'devtools_sources',
  modify_html: 'devtools_modify', modify_css: 'devtools_modify',
  get_network_logs: 'devtools_network', get_network_request_detail: 'devtools_network', clear_network_logs: 'devtools_network',
  get_cookies: 'devtools_storage', set_cookie: 'devtools_storage', delete_cookie: 'devtools_storage',
  get_local_storage: 'devtools_storage', set_local_storage: 'devtools_storage', remove_local_storage: 'devtools_storage',
  get_session_storage: 'devtools_storage', set_session_storage: 'devtools_storage', remove_session_storage: 'devtools_storage',
  get_console_logs: 'devtools_console', execute_javascript: 'devtools_console',

  // Phase 1: Visual Verification
  browser_snapshot: 'accessibility',
  get_element_layout: 'accessibility',
  detect_layout_issues: 'accessibility',
  compare_snapshots: 'accessibility',
  get_accessibility_tree: 'accessibility',
  diff_page_source: 'accessibility',

  // Phase 2: Emulation
  resize_viewport: 'emulation',
  emulate_device: 'emulation',
  reset_viewport: 'emulation',
  get_active_media_queries: 'emulation',
  get_viewport_info: 'emulation',

  // Phase 3: Smart Selectors
  find_element: 'elements',
  get_element_state: 'elements',
  query_shadow_dom: 'elements',
  get_computed_styles: 'elements',

  // Phase 4: Auditing
  run_accessibility_audit: 'audit',
  check_color_contrast: 'audit',
  get_tab_order: 'audit',
  get_performance_metrics: 'audit',
  check_font_loading: 'audit',
  audit_broken_resources: 'audit',
  check_security_headers: 'audit',
  detect_cookie_banners: 'audit',

  // Phase 5: Interaction
  hover_and_inspect: 'interaction',
  force_pseudo_state: 'interaction',
  get_tooltip_text: 'interaction',

  // Phase 6: Monitoring
  monitor_storage_events: 'monitoring',
  monitor_cookie_changes: 'monitoring',
  monitor_console_events: 'monitoring',

  // Phase 7: QA
  assert_element: 'qa',
  check_form_validity: 'qa',
  tab_to_next: 'qa',
  set_input_files: 'qa',
  emulate_network_conditions: 'qa',
  intercept_requests: 'qa',
  snapshot_page_state: 'qa',
  restore_page_state: 'qa',
  wait_for_condition: 'qa',
  assert_no_console_errors: 'qa',
  assert_no_network_errors: 'qa',
  get_network_errors: 'qa',
  stress_test_refresh: 'qa',
  assert_css_property: 'qa',
  assert_network_request_made: 'qa',
  assert_page_load_time: 'qa',
  get_all_issues: 'qa',

  // Gestures
  swipe: 'gestures',
  long_press: 'gestures',
  pinch: 'gestures',
  double_tap: 'gestures',

  // Macros
  start_recording_macro: 'macros',
  stop_recording_macro: 'macros',
  replay_macro: 'macros',

  // Multi-tab
  get_tab_state: 'tabs',
  assert_tabs_match: 'tabs',
  test_storage_sync: 'tabs',

  // Enhanced Shadow DOM
  deep_query_shadow_dom: 'elements',
  get_shadow_dom_tree: 'elements',

  // Performance
  record_performance_timeline: 'audit',
  record_focus_path: 'audit',
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

function isChromeInternalUrl(url: string): boolean {
  return url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('about:');
}

function isInternalPageWeShouldSkip(url: string): boolean {
  // When resolving fallback tabs, skip pages that are useless for automation
  return isChromeInternalUrl(url) || url.startsWith('https://chrome.google.com/webstore');
}

export async function resolveTabId(tabId?: number): Promise<number> {
  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (!tab) throw new Error(`Tab ${tabId} not found. Use list_tabs to find valid tab IDs.`);
      if (tab.id === undefined) throw new Error(`Tab ${tabId} has no valid ID.`);
      return tab.id;
    } catch (err: any) {
      if (err.message?.includes('No tab with id')) {
        throw new Error(`Tab ${tabId} not found. Use list_tabs to find valid tab IDs, or omit tabId to use the active tab.`);
      }
      throw err;
    }
  }
  // First try active tab in last focused window
  let tab: chrome.tabs.Tab | undefined = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  // Fallback: any active tab in any window
  if (!tab?.id) {
    tab = (await chrome.tabs.query({ active: true }))[0];
  }
  // Final fallback: first non-internal tab
  if (!tab?.id) {
    const allTabs = await chrome.tabs.query({});
    tab = allTabs.find((t) => t.id !== undefined && t.url && !isInternalPageWeShouldSkip(t.url));
  }
  if (!tab?.id) throw new Error('No active tab found. Open a web page in Chrome and try again.');
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
    const commandsThatSkipInternalCheck = new Set(['select_tab', 'close_tab', 'assert_tabs_match', 'test_storage_sync']);
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
      if (tab.url && isChromeInternalUrl(tab.url) && !commandsThatSkipInternalCheck.has(command)) {
        sendResponse(id, false, undefined, {
          code: 'INVALID_URL',
          message: `Cannot execute commands on internal browser pages (${tab.url}). Navigate to a regular web page first, or use select_tab to switch to a different tab.`,
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
    let message = err instanceof Error ? err.message : String(err);
    let code = 'EXECUTION_ERROR';

    // Provide more helpful error messages for common issues
    if (message.includes('Cannot access a chrome:// URL')) {
      message = 'The target tab is a Chrome internal page (chrome://). Navigate to a regular web page first, or use list_tabs to find a valid tab ID.';
      code = 'INVALID_URL';
    } else if (message.includes('No active tab found')) {
      message = 'No active tab found. Open a web page in Chrome before using this tool.';
      code = 'NO_ACTIVE_TAB';
    } else if (message.includes('No tab with id')) {
      message = 'The specified tab ID was not found. Use list_tabs to find valid tab IDs, or omit tabId to use the active tab.';
      code = 'TAB_NOT_FOUND';
    }

    sendResponse(id, false, undefined, { code, message });
  }
}
