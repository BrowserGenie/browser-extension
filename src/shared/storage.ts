import { ExtensionSettings, DEFAULT_SETTINGS } from './types.js';

export async function getSettings(): Promise<ExtensionSettings> {
  const data = await chrome.storage.local.get('settings');
  if (!data.settings) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...data.settings };
}

export async function saveSettings(settings: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await getSettings();
  const updated = { ...current, ...settings };
  await chrome.storage.local.set({ settings: updated });
  return updated;
}

export async function getApiKey(): Promise<string | null> {
  const settings = await getSettings();
  return settings.apiKeyEnabled ? settings.apiKey : null;
}

export async function getBlocklist(): Promise<string[]> {
  const settings = await getSettings();
  return settings.blocklist;
}

export async function getFeatureToggles(): Promise<Record<string, boolean>> {
  const settings = await getSettings();
  return settings.featureToggles;
}
