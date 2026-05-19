import { wsClient } from './websocket-client.js';
import { handleCommand } from './command-router.js';

// Register all handlers
import { registerNavigationHandlers } from './handlers/navigation.js';
import { registerTabManagementHandlers } from './handlers/tab-management.js';
import { registerKeyboardHandlers } from './handlers/keyboard.js';
import { registerScreenshotHandlers } from './handlers/screenshot.js';
import { registerClickHandlers } from './handlers/click.js';
import { registerInputHandlers } from './handlers/input.js';
import { registerDragDropHandlers } from './handlers/drag-drop.js';
import { registerHoverHandlers } from './handlers/hover.js';

import { registerDevtoolsSourcesHandlers } from './handlers/devtools-sources.js';
import { registerDevtoolsModifyHandlers } from './handlers/devtools-modify.js';
import { registerDevtoolsNetworkHandlers } from './handlers/devtools-network.js';
import { registerDevtoolsStorageHandlers } from './handlers/devtools-storage.js';
import { registerDevtoolsConsoleHandlers } from './handlers/devtools-console.js';

import { registerAccessibilityHandlers } from './handlers/accessibility.js';
import { registerEmulationHandlers } from './handlers/emulation.js';
import { registerElementHandlers } from './handlers/elements.js';
import { registerAuditHandlers } from './handlers/audit.js';
import { registerInteractionHandlers } from './handlers/interaction.js';
import { registerMonitoringHandlers } from './handlers/monitoring.js';
import { registerQaHandlers } from './handlers/qa.js';
import { registerGestureHandlers } from './handlers/gestures.js';
import { registerMacroHandlers } from './handlers/macros.js';
import { registerDomTreeHandlers, handleDomTreeUpdate, recordAction } from './handlers/dom-tree.js';

// Initialize all handlers
registerNavigationHandlers();
registerTabManagementHandlers();
registerKeyboardHandlers();
registerScreenshotHandlers();
registerClickHandlers();
registerInputHandlers();
registerDragDropHandlers();
registerHoverHandlers();

registerDevtoolsSourcesHandlers();
registerDevtoolsModifyHandlers();
registerDevtoolsNetworkHandlers();
registerDevtoolsStorageHandlers();
registerDevtoolsConsoleHandlers();

registerAccessibilityHandlers();
registerEmulationHandlers();
registerElementHandlers();
registerAuditHandlers();
registerInteractionHandlers();
registerMonitoringHandlers();
registerQaHandlers();
registerGestureHandlers();
registerMacroHandlers();
registerDomTreeHandlers();

// Record user actions in DOM tree history
const originalHandleCommand = handleCommand;
const wrappedHandleCommand = async (request: any) => {
  const result = await originalHandleCommand(request);
  try {
    if (request.tabId && request.command && !request.command.startsWith('get_') && !request.command.startsWith('list_')) {
      recordAction(request.tabId, request.command, request.params || {});
    }
  } catch {
    // Non-fatal
  }
  return result;
};

// Set up WebSocket message handling
wsClient.onMessage(async (request) => {
  await wrappedHandleCommand(request);
});

// Connect to MCP server
wsClient.connect();

// Route all alarms through the WebSocket client (reconnect + keepalive)
chrome.alarms.onAlarm.addListener((alarm) => {
  wsClient.handleAlarm(alarm.name);
});

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'get-connection-status') {
    sendResponse({ connected: wsClient.isConnected });
    return false;
  }
  if (message.type === 'dom-tree-update') {
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      handleDomTreeUpdate(tabId, message.payload);
    }
    return false;
  }
  return false;
});

console.log('[Background] BrowserGenie MCP Bridge service worker initialized');
