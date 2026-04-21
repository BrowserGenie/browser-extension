import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerDevtoolsStorageHandlers(): void {
  // --- Cookies ---
  registerHandler('get_cookies', async (params) => {
    const { url, name } = params as { url?: string; name?: string };
    const query: chrome.cookies.GetAllDetails = {};
    if (url) query.url = url;
    if (name) query.name = name;
    const cookies = await chrome.cookies.getAll(query);
    return cookies.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite,
      expirationDate: c.expirationDate,
    }));
  });

  registerHandler('set_cookie', async (params) => {
    const { name, value, url, domain, path, secure, httpOnly, sameSite, expirationDate } = params as {
      name: string; value: string; url?: string; domain?: string; path?: string;
      secure?: boolean; httpOnly?: boolean; sameSite?: chrome.cookies.SameSiteStatus;
      expirationDate?: number;
    };
    const details: chrome.cookies.SetDetails = { name, value, url: url || `https://${domain || 'localhost'}/` };
    if (domain) details.domain = domain;
    if (path) details.path = path;
    if (secure !== undefined) details.secure = secure;
    if (httpOnly !== undefined) details.httpOnly = httpOnly;
    if (sameSite) details.sameSite = sameSite;
    if (expirationDate) details.expirationDate = expirationDate;
    const cookie = await chrome.cookies.set(details);
    return cookie;
  });

  registerHandler('delete_cookie', async (params) => {
    const { name, url } = params as { name: string; url: string };
    await chrome.cookies.remove({ name, url });
    return { deleted: true };
  });

  // --- Local Storage ---
  registerHandler('get_local_storage', async (params, tabId) => {
    const { key } = params as { key?: string };
    await debuggerManager.enableDomain(tabId, 'Runtime');
    const script = key
      ? `localStorage.getItem(${JSON.stringify(key)})`
      : `(() => { const obj = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); obj[k] = localStorage.getItem(k); } return obj; })()`;
    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script, returnByValue: true,
    })) as { result: { value: unknown } };
    return result.result.value;
  });

  registerHandler('set_local_storage', async (params, tabId) => {
    const { key, value } = params as { key: string; value: string };
    await debuggerManager.enableDomain(tabId, 'Runtime');
    await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    });
    return { key, set: true };
  });

  registerHandler('remove_local_storage', async (params, tabId) => {
    const { key } = params as { key: string };
    await debuggerManager.enableDomain(tabId, 'Runtime');
    await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: `localStorage.removeItem(${JSON.stringify(key)})`,
    });
    return { key, removed: true };
  });

  // --- Session Storage ---
  registerHandler('get_session_storage', async (params, tabId) => {
    const { key } = params as { key?: string };
    await debuggerManager.enableDomain(tabId, 'Runtime');
    const script = key
      ? `sessionStorage.getItem(${JSON.stringify(key)})`
      : `(() => { const obj = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); obj[k] = sessionStorage.getItem(k); } return obj; })()`;
    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script, returnByValue: true,
    })) as { result: { value: unknown } };
    return result.result.value;
  });

  registerHandler('set_session_storage', async (params, tabId) => {
    const { key, value } = params as { key: string; value: string };
    await debuggerManager.enableDomain(tabId, 'Runtime');
    await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
    });
    return { key, set: true };
  });

  registerHandler('remove_session_storage', async (params, tabId) => {
    const { key } = params as { key: string };
    await debuggerManager.enableDomain(tabId, 'Runtime');
    await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: `sessionStorage.removeItem(${JSON.stringify(key)})`,
    });
    return { key, removed: true };
  });
}
