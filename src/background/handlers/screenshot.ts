import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerScreenshotHandlers(): void {
  registerHandler('screenshot_viewport', async (params, tabId) => {
    const { format = 'png', quality, method = 'auto' } = params as {
      format?: 'png' | 'jpeg';
      quality?: number;
      method?: 'auto' | 'cdp' | 'tabs';
    };

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';

    // CDP-based capture respects the live compositor so modals / high-z-index overlays
    // that `chrome.tabs.captureVisibleTab` sometimes misses (especially when layered
    // on top of a drawer) show up correctly. 'auto' tries CDP first and falls back to
    // tabs API — the opposite of the previous default which hid modals behind drawers.
    const captureViaCdp = async (): Promise<{ image: string; mimeType: string } | null> => {
      try {
        await debuggerManager.ensureAttached(tabId);
        const result = (await debuggerManager.sendCommand(tabId, 'Page.captureScreenshot', {
          format: format === 'jpeg' ? 'jpeg' : 'png',
          quality: format === 'jpeg' ? (quality ?? 80) : undefined,
          fromSurface: true,
          captureBeyondViewport: false,
        })) as { data: string };
        return { image: result.data, mimeType };
      } catch {
        return null;
      }
    };

    const captureViaTabs = async (): Promise<{ image: string; mimeType: string } | null> => {
      const captureOptions: chrome.tabs.CaptureVisibleTabOptions = {
        format: format === 'jpeg' ? 'jpeg' : 'png',
        quality,
      };
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(captureOptions);
          const base64 = dataUrl.split(',')[1];
          return { image: base64, mimeType };
        } catch {
          if (attempt === 0) await new Promise((r) => setTimeout(r, 200));
        }
      }
      return null;
    };

    if (method === 'tabs') {
      const r = await captureViaTabs();
      if (r) return r;
      const c = await captureViaCdp();
      if (c) return c;
      throw new Error('Failed to capture viewport screenshot');
    }

    // method === 'cdp' or 'auto'
    const c = await captureViaCdp();
    if (c) return c;
    const t = await captureViaTabs();
    if (t) return t;
    throw new Error('Failed to capture viewport screenshot');
  });

  registerHandler('screenshot_full_page', async (params, tabId) => {
    const { format = 'png', quality } = params as { format?: 'png' | 'jpeg'; quality?: number };
    await debuggerManager.ensureAttached(tabId);

    const metrics = (await debuggerManager.sendCommand(tabId, 'Page.getLayoutMetrics')) as {
      contentSize: { width: number; height: number };
      cssContentSize: { width: number; height: number };
    };

    const width = Math.ceil(metrics.cssContentSize.width);
    const height = Math.ceil(metrics.cssContentSize.height);

    await debuggerManager.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      mobile: false,
      width,
      height,
      deviceScaleFactor: 1,
    });

    const result = (await debuggerManager.sendCommand(tabId, 'Page.captureScreenshot', {
      format: format === 'jpeg' ? 'jpeg' : 'png',
      quality: format === 'jpeg' ? (quality ?? 80) : undefined,
      clip: { x: 0, y: 0, width, height, scale: 1 },
      captureBeyondViewport: true,
    })) as { data: string };

    await debuggerManager.sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride');

    return {
      image: result.data,
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  });

  registerHandler('screenshot_element', async (params, tabId) => {
    const { selector, selectorType = 'css', format = 'png', quality } = params as {
      selector: string;
      selectorType?: 'css' | 'xpath';
      format?: 'png' | 'jpeg';
      quality?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    const findScript = selectorType === 'css'
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`
      : `(() => {
          const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = res.singleNodeValue;
          if (!el || !(el instanceof Element)) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`;

    const evalResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: findScript,
      returnByValue: true,
    })) as { result: { value: { x: number; y: number; width: number; height: number } | null } };

    if (!evalResult.result.value) {
      throw new Error(`Element not found: ${selector}`);
    }

    const { x, y, width, height } = evalResult.result.value;
    const clip = {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
      scale: 1,
    };

    const result = (await debuggerManager.sendCommand(tabId, 'Page.captureScreenshot', {
      format: format === 'jpeg' ? 'jpeg' : 'png',
      quality: format === 'jpeg' ? (quality ?? 80) : undefined,
      clip,
    })) as { data: string };

    return {
      image: result.data,
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  });
}
