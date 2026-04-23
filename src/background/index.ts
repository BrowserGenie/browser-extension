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

// Set up WebSocket message handling
wsClient.onMessage(async (request) => {
  await handleCommand(request);
});

// Connect to MCP server
wsClient.connect();

// Route all alarms through the WebSocket client (reconnect + keepalive)
chrome.alarms.onAlarm.addListener((alarm) => {
  wsClient.handleAlarm(alarm.name);
});

// Handle messages from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'get-connection-status') {
    sendResponse({ connected: wsClient.isConnected });
    return false;
  }
  // Forward other messages (e.g., offscreen document responses) — handled by their respective handlers
  return false;
});

console.log('[Background] BrowserGenie MCP Bridge service worker initialized');
