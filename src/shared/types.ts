export interface CommandRequest {
  id: string;
  type: 'request';
  command: string;
  params: Record<string, unknown>;
  tabId?: number;
  apiKey?: string;
  timestamp: number;
}

export interface CommandResponse {
  id: string;
  type: 'response';
  requestId: string;
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
  };
  timestamp: number;
}

export interface ExtensionSettings {
  apiKey: string | null;
  apiKeyEnabled: boolean;
  blocklist: string[];
  featureToggles: Record<string, boolean>;
  wsPort: number;
}

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiKey: null,
  apiKeyEnabled: false,
  blocklist: [],
  featureToggles: {
    navigation: true,
    tabs: true,
    keyboard: true,
    interaction: true,
    screenshots: true,

    devtools_sources: true,
    devtools_modify: true,
    devtools_network: true,
    devtools_storage: true,
    devtools_console: true,
  },
  wsPort: 7890,
};
