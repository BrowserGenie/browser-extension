import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerEmulationHandlers(): void {
  registerHandler('resize_viewport', async (params, tabId) => {
    const { width, height, deviceScaleFactor = 1, mobile = false, userAgent, touch = false } = params as {
      width: number;
      height: number;
      deviceScaleFactor?: number;
      mobile?: boolean;
      userAgent?: string;
      touch?: boolean;
    };
    await debuggerManager.ensureAttached(tabId);

    await debuggerManager.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });

    if (userAgent) {
      await debuggerManager.sendCommand(tabId, 'Emulation.setUserAgentOverride', { userAgent });
    }

    if (touch) {
      await debuggerManager.sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true });
    }

    return { width, height, deviceScaleFactor, mobile, touch, userAgent };
  });

  registerHandler('emulate_device', async (params, tabId) => {
    const { width, height, deviceScaleFactor, mobile, touch, userAgent } = params as {
      width: number;
      height: number;
      deviceScaleFactor: number;
      mobile: boolean;
      touch: boolean;
      userAgent?: string;
    };
    await debuggerManager.ensureAttached(tabId);

    await debuggerManager.sendCommand(tabId, 'Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile,
    });

    if (userAgent) {
      await debuggerManager.sendCommand(tabId, 'Emulation.setUserAgentOverride', { userAgent });
    }

    if (touch) {
      await debuggerManager.sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: true });
    }

    return { width, height, deviceScaleFactor, mobile, touch, userAgent };
  });

  registerHandler('reset_viewport', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.sendCommand(tabId, 'Emulation.clearDeviceMetricsOverride');
    await debuggerManager.sendCommand(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' });
    await debuggerManager.sendCommand(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    return { reset: true };
  });

  registerHandler('get_active_media_queries', async (params, tabId) => {
    const { breakpoints = [320, 375, 428, 480, 640, 768, 1024, 1280, 1440, 1920] } = params as { breakpoints?: number[] };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const activeBreakpoints = ${JSON.stringify(breakpoints)}.filter(bp => window.matchMedia('(max-width: ' + bp + 'px)').matches);
      const mediaRules = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules || []) {
            if (rule.type === CSSRule.MEDIA_RULE) {
              mediaRules.push({
                query: rule.conditionText || rule.media.mediaText,
                active: window.matchMedia(rule.conditionText || rule.media.mediaText).matches,
                stylesheetUrl: sheet.href || '(inline)',
              });
            }
          }
        } catch (e) {
          // Cross-origin stylesheet
        }
      }
      return { activeBreakpoints, mediaRules };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_viewport_info', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const viewportMeta = document.querySelector('meta[name=viewport]');
      const viewportContent = viewportMeta ? viewportMeta.getAttribute('content') : null;
      const parsedViewport = {};
      if (viewportContent) {
        for (const part of viewportContent.split(',')) {
          const [k, v] = part.split('=').map(s => s.trim());
          parsedViewport[k] = v;
        }
      }
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        viewportMeta: viewportContent,
        parsedViewport,
        screenWidth: screen.width,
        screenHeight: screen.height,
        orientation: screen.orientation ? screen.orientation.type : null,
        userAgent: navigator.userAgent,
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });
}
