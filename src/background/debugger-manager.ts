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
