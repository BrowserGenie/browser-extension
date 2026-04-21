import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

const KEY_DEFINITIONS: Record<string, { key: string; code: string; keyCode: number; windowsVirtualKeyCode: number }> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, windowsVirtualKeyCode: 13 },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9, windowsVirtualKeyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27, windowsVirtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8, windowsVirtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46, windowsVirtualKeyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38, windowsVirtualKeyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40, windowsVirtualKeyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37, windowsVirtualKeyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39, windowsVirtualKeyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36, windowsVirtualKeyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35, windowsVirtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33, windowsVirtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34, windowsVirtualKeyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, windowsVirtualKeyCode: 32 },
  F1: { key: 'F1', code: 'F1', keyCode: 112, windowsVirtualKeyCode: 112 },
  F2: { key: 'F2', code: 'F2', keyCode: 113, windowsVirtualKeyCode: 113 },
  F3: { key: 'F3', code: 'F3', keyCode: 114, windowsVirtualKeyCode: 114 },
  F4: { key: 'F4', code: 'F4', keyCode: 115, windowsVirtualKeyCode: 115 },
  F5: { key: 'F5', code: 'F5', keyCode: 116, windowsVirtualKeyCode: 116 },
  F6: { key: 'F6', code: 'F6', keyCode: 117, windowsVirtualKeyCode: 117 },
  F7: { key: 'F7', code: 'F7', keyCode: 118, windowsVirtualKeyCode: 118 },
  F8: { key: 'F8', code: 'F8', keyCode: 119, windowsVirtualKeyCode: 119 },
  F9: { key: 'F9', code: 'F9', keyCode: 120, windowsVirtualKeyCode: 120 },
  F10: { key: 'F10', code: 'F10', keyCode: 121, windowsVirtualKeyCode: 121 },
  F11: { key: 'F11', code: 'F11', keyCode: 122, windowsVirtualKeyCode: 122 },
  F12: { key: 'F12', code: 'F12', keyCode: 123, windowsVirtualKeyCode: 123 },
};

function getModifierFlags(modifiers?: string[]): number {
  let flags = 0;
  if (modifiers) {
    if (modifiers.includes('Alt')) flags |= 1;
    if (modifiers.includes('Control')) flags |= 2;
    if (modifiers.includes('Meta')) flags |= 4;
    if (modifiers.includes('Shift')) flags |= 8;
  }
  return flags;
}

async function resolveAndClickElement(tabId: number, selector: string, selectorType: 'css' | 'xpath'): Promise<void> {
  await debuggerManager.enableDomain(tabId, 'Runtime');
  const script = selectorType === 'css'
    ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
    : `(() => { const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue; if (!el || !(el instanceof Element)) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;

  const coordResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
    expression: script, returnByValue: true,
  })) as { result: { value: { x: number; y: number } | null } };

  if (!coordResult.result.value) throw new Error(`Element not found: ${selector}`);
  const { x, y } = coordResult.result.value;

  // Real mouse click establishes OS focus — required for Input.dispatchKeyEvent to reach this element
  await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function dispatchKey(tabId: number, keyDef: { key: string; code: string; windowsVirtualKeyCode: number }, modifierFlags: number): Promise<void> {
  const base = {
    key: keyDef.key,
    code: keyDef.code,
    windowsVirtualKeyCode: keyDef.windowsVirtualKeyCode,
    nativeVirtualKeyCode: keyDef.windowsVirtualKeyCode,
    modifiers: modifierFlags,
  };
  await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  // char event carries the text for printable keys so the input value actually updates
  if (keyDef.key.length === 1) {
    await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'char', key: keyDef.key, text: keyDef.key, modifiers: modifierFlags });
  }
  await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export function registerKeyboardHandlers(): void {
  registerHandler('press_key', async (params, tabId) => {
    const { key, modifiers, selector, selectorType = 'css' } = params as {
      key: string;
      modifiers?: string[];
      selector?: string;
      selectorType?: 'css' | 'xpath';
    };

    await debuggerManager.ensureAttached(tabId);

    // Click the target element via real mouse events to give it OS focus.
    // Input.dispatchKeyEvent targets OS focus (not DOM focus), so without this
    // the key event goes to whatever Chrome natively has focused.
    if (selector) {
      await resolveAndClickElement(tabId, selector, selectorType);
    }

    const modifierFlags = getModifierFlags(modifiers);
    const keyDef = KEY_DEFINITIONS[key];

    if (keyDef) {
      await dispatchKey(tabId, keyDef, modifierFlags);
    } else if (key.length === 1) {
      const charDef = {
        key,
        code: `Key${key.toUpperCase()}`,
        windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      };
      await dispatchKey(tabId, charDef, modifierFlags);
    } else {
      throw new Error(`Unknown key: ${key}`);
    }

    return { key, modifiers, selector };
  });

  registerHandler('type_text', async (params, tabId) => {
    const { text, delay = 50 } = params as { text: string; delay?: number };
    await debuggerManager.ensureAttached(tabId);

    for (const char of text) {
      await debuggerManager.sendCommand(tabId, 'Input.insertText', { text: char });
      if (delay > 0) {
        await new Promise((r) => setTimeout(r, delay));
      }
    }

    return { typed: text.length };
  });
}
