const CDP_VERSION = '1.3';

class DebuggerManager {
  private attachedTabs = new Set<number>();
  private enabledDomains = new Map<number, Set<string>>();

  constructor() {
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId !== undefined) {
        this.attachedTabs.delete(source.tabId);
        this.enabledDomains.delete(source.tabId);
        console.log(`[Debugger] Detached from tab ${source.tabId}: ${reason}`);
      }
    });

    chrome.tabs.onRemoved.addListener((tabId) => {
      this.attachedTabs.delete(tabId);
      this.enabledDomains.delete(tabId);
    });

    // Auto-accept JavaScript dialogs (beforeunload warnings, alert(), etc.) so an
    // automation run isn't blocked waiting for the user to click OK. Without this,
    // navigate/reload on a page with a beforeunload handler would hang the tab.
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (method !== 'Page.javascriptDialogOpening' || source.tabId === undefined) return;
      const dlg = params as { type?: string; message?: string; defaultPrompt?: string };
      // Always accept beforeunload (the "leave site?" reload warning). For alert/confirm/prompt
      // we still accept by default to avoid automation hangs, but log a warning so users
      // know an interactive dialog was bypassed.
      if (dlg.type && dlg.type !== 'beforeunload' && dlg.type !== 'alert' && dlg.type !== 'confirm' && dlg.type !== 'prompt') {
        // Unknown dialog type — best effort accept
        console.warn(`[Debugger] Unknown dialog type "${dlg.type}" auto-accepted. Message: ${dlg.message}`);
      } else if (dlg.type === 'alert' || dlg.type === 'confirm' || dlg.type === 'prompt') {
        console.warn(`[Debugger] Auto-accepted ${dlg.type} dialog during automation. Message: ${dlg.message}`);
      }
      chrome.debugger.sendCommand({ tabId: source.tabId }, 'Page.handleJavaScriptDialog', {
        accept: true,
        promptText: dlg.defaultPrompt || '',
      }).catch((err) => {
        console.warn('[Debugger] Failed to auto-accept dialog:', err?.message || err);
      });
    });
  }

  async ensureAttached(tabId: number): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    this.attachedTabs.add(tabId);
    this.enabledDomains.set(tabId, new Set());
    await this.enableCoreDomains(tabId);
  }

  async enableCoreDomains(tabId: number): Promise<void> {
    await this.enableDomain(tabId, 'Network');
    await this.enableDomain(tabId, 'Runtime');
    await this.enableDomain(tabId, 'Page');
  }

  async enableDomain(tabId: number, domain: string): Promise<void> {
    await this.ensureAttached(tabId);
    const domains = this.enabledDomains.get(tabId)!;
    if (domains.has(domain)) return;
    await chrome.debugger.sendCommand({ tabId }, `${domain}.enable`);
    domains.add(domain);
  }

  async sendCommand(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    await this.ensureAttached(tabId);
    return chrome.debugger.sendCommand({ tabId }, method, params);
  }

  async detach(tabId: number): Promise<void> {
    if (!this.attachedTabs.has(tabId)) return;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      // Already detached
    }
    this.attachedTabs.delete(tabId);
    this.enabledDomains.delete(tabId);
  }

  isAttached(tabId: number): boolean {
    return this.attachedTabs.has(tabId);
  }
}

export const debuggerManager = new DebuggerManager();
