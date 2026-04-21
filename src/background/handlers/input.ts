import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerInputHandlers(): void {
  registerHandler('input_and_type', async (params, tabId) => {
    const { selector, selectorType = 'css', text, clearFirst = true, submit = false } = params as {
      selector: string;
      selectorType?: 'css' | 'xpath';
      text: string;
      clearFirst?: boolean;
      submit?: boolean;
    };

    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'Runtime');

    // Resolve element center coordinates
    const script = selectorType === 'css'
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
      : `(() => { const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue; if (!el || !(el instanceof Element)) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;

    const coordResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script, returnByValue: true,
    })) as { result: { value: { x: number; y: number } | null } };

    if (!coordResult.result.value) throw new Error(`Input element not found: ${selector}`);
    const { x, y } = coordResult.result.value;

    // Real mouse click — moves cursor visibly and establishes OS focus so key events land here
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

    // Clear existing text via Ctrl+A then Delete — visible to the user like a real action
    if (clearFirst) {
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    }

    // Type text through the real input pipeline
    await debuggerManager.sendCommand(tabId, 'Input.insertText', { text });

    // Submit via Enter key — works because OS focus is on this input
    if (submit) {
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    }

    return { selector, typed: text.length, cleared: clearFirst, submitted: submit };
  });
}
