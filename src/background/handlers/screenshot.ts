import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

/**
 * Retry a screenshot capture with exponential backoff.
 * Addresses issue where screenshots fail after long sequences of rapid tool calls
 * (possible rate limiting or state corruption).
 */
async function retryCapture<T>(fn: () => Promise<T | null>, maxRetries = 3, baseDelayMs = 200): Promise<T | null> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const result = await fn();
    if (result) return result;
    if (attempt < maxRetries - 1) {
      const delay = baseDelayMs * Math.pow(2, attempt); // 200, 400, 800
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}

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

    const captureViaTabs = async (targetTabId: number): Promise<{ image: string; mimeType: string } | null> => {
      const captureOptions: chrome.tabs.CaptureVisibleTabOptions = {
        format: format === 'jpeg' ? 'jpeg' : 'png',
        quality,
      };
      try {
        // Find the window containing the target tab to capture the correct viewport
        const tab = await chrome.tabs.get(targetTabId);
        if (!tab.windowId) return null;
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, captureOptions);
        const base64 = dataUrl.split(',')[1];
        return { image: base64, mimeType };
      } catch {
        return null;
      }
    };

    if (method === 'tabs') {
      const r = await retryCapture(() => captureViaTabs(tabId));
      if (r) return r;
      const c = await retryCapture(captureViaCdp);
      if (c) return c;
      throw new Error('Failed to capture viewport screenshot after retries');
    }

    // method === 'cdp' or 'auto'
    const c = await retryCapture(captureViaCdp);
    if (c) return c;
    const t = await retryCapture(() => captureViaTabs(tabId));
    if (t) return t;
    throw new Error('Failed to capture viewport screenshot after retries');
  });

  registerHandler('screenshot_full_page', async (params, tabId) => {
    const { format = 'png', quality } = params as { format?: 'png' | 'jpeg'; quality?: number };
    await debuggerManager.ensureAttached(tabId);

    // Save current scroll position to restore after capture
    const scrollPos = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: `(() => ({ x: window.scrollX, y: window.scrollY }))()`,
      returnByValue: true,
    })) as { result: { value: { x: number; y: number } } };

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

    try {
      const captureFullPage = async (): Promise<{ image: string; mimeType: string } | null> => {
        try {
          const result = (await debuggerManager.sendCommand(tabId, 'Page.captureScreenshot', {
            format: format === 'jpeg' ? 'jpeg' : 'png',
            quality: format === 'jpeg' ? (quality ?? 80) : undefined,
            clip: { x: 0, y: 0, width, height, scale: 1 },
            captureBeyondViewport: true,
          })) as { data: string };
          return {
            image: result.data,
            mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
          };
        } catch {
          return null;
        }
      };

      const result = await retryCapture(captureFullPage);
      if (!result) {
        throw new Error('Failed to capture full page screenshot after retries');
      }
      return result;
    } finally {
      await debuggerManager.sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      // Restore scroll position
      const pos = scrollPos?.result?.value;
      if (pos) {
        await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
          expression: `window.scrollTo(${pos.x}, ${pos.y})`,
          returnByValue: true,
        }).catch(() => {});
      }
    }
  });

  registerHandler('screenshot_element', async (params, tabId) => {
    const { selector, selectorType = 'css', format = 'png', quality } = params as {
      selector: string;
      selectorType?: 'css' | 'xpath';
      format?: 'png' | 'jpeg';
      quality?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    // Scroll element into view before capturing to ensure it's within the viewport
    const findScript = selectorType === 'css'
      ? `(() => {
          const el = document.querySelector(${JSON.stringify(selector)});
          if (!el) return null;
          if (typeof el.scrollIntoViewIfNeeded === 'function') {
            el.scrollIntoViewIfNeeded(true);
          } else {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          }
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height };
        })()`
      : `(() => {
          const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
          const el = res.singleNodeValue;
          if (!el || !(el instanceof Element)) return null;
          if (typeof el.scrollIntoViewIfNeeded === 'function') {
            el.scrollIntoViewIfNeeded(true);
          } else {
            el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
          }
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
      x: Math.floor(x),
      y: Math.floor(y),
      width: Math.ceil(width),
      height: Math.ceil(height),
      scale: 1,
    };

    const captureElement = async (): Promise<{ image: string; mimeType: string } | null> => {
      try {
        const result = (await debuggerManager.sendCommand(tabId, 'Page.captureScreenshot', {
          format: format === 'jpeg' ? 'jpeg' : 'png',
          quality: format === 'jpeg' ? (quality ?? 80) : undefined,
          clip,
        })) as { data: string };
        return {
          image: result.data,
          mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
        };
      } catch {
        return null;
      }
    };

    const result = await retryCapture(captureElement);
    if (!result) {
      throw new Error(`Failed to capture element screenshot after retries: ${selector}`);
    }
    return result;
  });
}
