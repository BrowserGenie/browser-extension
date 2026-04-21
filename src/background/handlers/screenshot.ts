import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerScreenshotHandlers(): void {
  registerHandler('screenshot_viewport', async (params, tabId) => {
    const { format = 'png', quality } = params as { format?: 'png' | 'jpeg'; quality?: number };

    const mimeType = format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const captureOptions: chrome.tabs.CaptureVisibleTabOptions = { format: format === 'jpeg' ? 'jpeg' : 'png', quality };

    // captureVisibleTab can fail with "image readback failed" if the compositor
    // isn't ready; retry once before falling back to CDP Page.captureScreenshot.
    let dataUrl: string | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        dataUrl = await chrome.tabs.captureVisibleTab(captureOptions);
        break;
      } catch (err) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 200));
        } else {
          // CDP fallback
          await debuggerManager.ensureAttached(tabId);
          const result = (await debuggerManager.sendCommand(tabId, 'Page.captureScreenshot', {
            format: format === 'jpeg' ? 'jpeg' : 'png',
            quality: format === 'jpeg' ? (quality ?? 80) : undefined,
            fromSurface: true,
          })) as { data: string };
          return { image: result.data, mimeType };
        }
      }
    }

    const base64 = dataUrl!.split(',')[1];
    return { image: base64, mimeType };
  });

  registerHandler('screenshot_full_page', async (params, tabId) => {
    const { format = 'png', quality } = params as { format?: 'png' | 'jpeg'; quality?: number };
    await debuggerManager.ensureAttached(tabId);

    // Get page metrics
    const metrics = (await debuggerManager.sendCommand(tabId, 'Page.getLayoutMetrics')) as {
      contentSize: { width: number; height: number };
      cssContentSize: { width: number; height: number };
    };

    const width = Math.ceil(metrics.cssContentSize.width);
    const height = Math.ceil(metrics.cssContentSize.height);

    // Override device metrics for full page
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

    // Reset device metrics
    await debuggerManager.sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride');

    return {
      image: result.data,
      mimeType: format === 'jpeg' ? 'image/jpeg' : 'image/png',
    };
  });
}
