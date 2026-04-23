import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

interface RecordedEvent {
  type: string;
  timestamp: number;
  selector?: string;
  x?: number;
  y?: number;
  key?: string;
  text?: string;
  value?: string;
}

interface Macro {
  events: RecordedEvent[];
  startUrl?: string;
}

const macros = new Map<string, Macro>();

export function registerMacroHandlers(): void {
  registerHandler('start_recording_macro', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/macro-recorder.js'],
      world: 'MAIN',
    });

    const script = `(() => {
      if (window.__browserGenieMacroRecorder) {
        return window.__browserGenieMacroRecorder.start();
      }
      return { error: 'Macro recorder not loaded' };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('stop_recording_macro', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      if (window.__browserGenieMacroRecorder) {
        return window.__browserGenieMacroRecorder.stop();
      }
      return { error: 'Macro recorder not loaded' };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: { events: RecordedEvent[] } } };

    const events = result.result.value?.events || [];
    return { events, count: events.length };
  });

  registerHandler('replay_macro', async (params, tabId) => {
    const { events, speed = 1.0 } = params as {
      events: RecordedEvent[];
      speed?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    if (!events || events.length === 0) {
      return { error: 'No events to replay' };
    }

    const results = [];
    let lastTimestamp = events[0].timestamp;

    for (const event of events) {
      const delay = (event.timestamp - lastTimestamp) / speed;
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
      lastTimestamp = event.timestamp;

      try {
        if (event.type === 'click' && event.selector) {
          const clickScript = `(() => {
            const el = document.querySelector(${JSON.stringify(event.selector)});
            if (!el) return { error: 'Element not found' };
            el.click();
            return { clicked: true };
          })()`;
          const clickResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression: clickScript,
            returnByValue: true,
          })) as { result: { value: { error?: string } } };
          results.push({ type: 'click', success: !clickResult.result.value?.error, result: clickResult.result.value });
        } else if (event.type === 'input' && event.selector) {
          const inputScript = `(() => {
            const el = document.querySelector(${JSON.stringify(event.selector)});
            if (!el) return { error: 'Element not found' };
            (el as HTMLInputElement).value = ${JSON.stringify(event.text || '')};
            el.dispatchEvent(new Event('input', { bubbles: true }));
            return { input: true };
          })()`;
          const inputResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression: inputScript,
            returnByValue: true,
          })) as { result: { value: { error?: string } } };
          results.push({ type: 'input', success: !inputResult.result.value?.error, result: inputResult.result.value });
        } else if (event.type === 'keydown' && event.key) {
          const keyScript = `(() => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(event.key)}, bubbles: true }));
            return { keyPressed: true };
          })()`;
          await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression: keyScript,
            returnByValue: true,
          });
          results.push({ type: 'keydown', success: true });
        } else if (event.type === 'change' && event.selector) {
          const changeScript = `(() => {
            const el = document.querySelector(${JSON.stringify(event.selector)});
            if (!el) return { error: 'Element not found' };
            (el as HTMLInputElement).value = ${JSON.stringify(event.value || '')};
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { changed: true };
          })()`;
          const changeResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression: changeScript,
            returnByValue: true,
          })) as { result: { value: { error?: string } } };
          results.push({ type: 'change', success: !changeResult.result.value?.error, result: changeResult.result.value });
        }
      } catch (err: any) {
        results.push({ type: event.type, success: false, error: err.message });
      }
    }

    return { replayed: true, eventCount: events.length, results };
  });
}
