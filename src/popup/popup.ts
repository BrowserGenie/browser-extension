import { getSettings, saveSettings } from '../shared/storage.js';
import { ExtensionSettings } from '../shared/types.js';

const FEATURE_LABELS: Record<string, string> = {
  navigation: 'Navigation',
  tabs: 'Tab Management',
  keyboard: 'Keyboard Input',
  interaction: 'Click / Drag / Hover',
  screenshots: 'Screenshots',

  devtools_sources: 'DevTools: Sources',
  devtools_modify: 'DevTools: Modify DOM/CSS',
  devtools_network: 'DevTools: Network Logs',
  devtools_storage: 'DevTools: Storage (Cookies/LS/SS)',
  devtools_console: 'DevTools: Console & JS Execution',
};

let settings: ExtensionSettings;

async function init(): Promise<void> {
  settings = await getSettings();
  renderConnectionStatus();
  renderApiKey();
  renderBlocklist();
  renderFeatureToggles();
  bindEvents();
}

function renderConnectionStatus(): void {
  chrome.runtime.sendMessage({ type: 'get-connection-status' }, (response) => {
    const el = document.getElementById('connection-status')!;
    const textEl = el.querySelector('.status-text')!;
    if (response?.connected) {
      el.className = 'status connected';
      textEl.textContent = 'Connected';
    } else {
      el.className = 'status disconnected';
      textEl.textContent = 'Disconnected';
    }
  });
}

function renderApiKey(): void {
  const toggle = document.getElementById('api-key-toggle') as HTMLInputElement;
  const section = document.getElementById('api-key-section')!;
  const display = document.getElementById('api-key-display') as HTMLInputElement;

  toggle.checked = settings.apiKeyEnabled;
  section.classList.toggle('hidden', !settings.apiKeyEnabled);
  display.value = settings.apiKey || '';
}

function renderBlocklist(): void {
  const list = document.getElementById('blocklist')!;
  list.innerHTML = '';
  for (const url of settings.blocklist) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${escapeHtml(url)}</span><button class="remove-btn" data-url="${escapeHtml(url)}">&times;</button>`;
    list.appendChild(li);
  }
}

function renderFeatureToggles(): void {
  const container = document.getElementById('feature-toggles')!;
  container.innerHTML = '';
  for (const [key, label] of Object.entries(FEATURE_LABELS)) {
    const enabled = settings.featureToggles[key] !== false;
    const row = document.createElement('div');
    row.className = 'toggle-row';
    row.innerHTML = `
      <label>${label}</label>
      <label class="switch">
        <input type="checkbox" data-feature="${key}" ${enabled ? 'checked' : ''}>
        <span class="slider"></span>
      </label>`;
    container.appendChild(row);
  }
}

function bindEvents(): void {
  // API Key toggle
  document.getElementById('api-key-toggle')!.addEventListener('change', async (e) => {
    const checked = (e.target as HTMLInputElement).checked;
    settings = await saveSettings({ apiKeyEnabled: checked });
    renderApiKey();
  });

  // Generate key
  document.getElementById('generate-key-btn')!.addEventListener('click', async () => {
    const key = crypto.randomUUID();
    settings = await saveSettings({ apiKey: key });
    renderApiKey();
  });

  // Rotate key
  document.getElementById('rotate-key-btn')!.addEventListener('click', async () => {
    const key = crypto.randomUUID();
    settings = await saveSettings({ apiKey: key });
    renderApiKey();
  });

  // Copy key
  document.getElementById('copy-key-btn')!.addEventListener('click', () => {
    const display = document.getElementById('api-key-display') as HTMLInputElement;
    if (display.value) {
      navigator.clipboard.writeText(display.value);
      const btn = document.getElementById('copy-key-btn')!;
      btn.title = 'Copied!';
      setTimeout(() => { btn.title = 'Copy'; }, 1500);
    }
  });

  // Add blocklist
  document.getElementById('add-blocklist-btn')!.addEventListener('click', async () => {
    const input = document.getElementById('blocklist-input') as HTMLInputElement;
    const url = input.value.trim();
    if (url && !settings.blocklist.includes(url)) {
      settings = await saveSettings({ blocklist: [...settings.blocklist, url] });
      renderBlocklist();
      input.value = '';
    }
  });

  // Remove blocklist
  document.getElementById('blocklist')!.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    if (target.classList.contains('remove-btn')) {
      const url = target.dataset.url!;
      settings = await saveSettings({ blocklist: settings.blocklist.filter((u) => u !== url) });
      renderBlocklist();
    }
  });

  // Feature toggles
  document.getElementById('feature-toggles')!.addEventListener('change', async (e) => {
    const input = e.target as HTMLInputElement;
    const feature = input.dataset.feature!;
    const toggles = { ...settings.featureToggles, [feature]: input.checked };
    settings = await saveSettings({ featureToggles: toggles });
  });
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Refresh connection status periodically
setInterval(renderConnectionStatus, 3000);

init();
