import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

function randomDelay(min: number, max: number): Promise<void> {
  const delay = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, delay));
}

// True on macOS — the browser uses Meta (⌘) where other OSes use Control
// (e.g. select-all, copy, paste). Chrome extensions can reliably detect the platform
// from the browser's UA/platform strings, not the dev machine's process.platform.
async function isMacPlatform(): Promise<boolean> {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    return info.os === 'mac';
  } catch {
    return false;
  }
}

export function registerInputHandlers(): void {
  registerHandler('input_and_type', async (params, tabId) => {
    const { selector, selectorType = 'css', text, clearFirst = true, submit = false, nth = 0 } = params as {
      selector: string;
      selectorType?: 'css' | 'xpath';
      text: string;
      clearFirst?: boolean;
      submit?: boolean;
      nth?: number;
    };

    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'Runtime');

    // Resolve the Nth matching element's center coordinates (0-indexed).
    // Both CSS and XPath paths honor nth: the CSS path uses querySelectorAll and
    // XPath uses ORDERED_NODE_SNAPSHOT_TYPE so multi-match selectors work.
    const script = selectorType === 'css'
      ? `(() => {
          const list = document.querySelectorAll(${JSON.stringify(selector)});
          const el = list[${nth}];
          if (!el) return { found: false, total: list.length };
          const r = el.getBoundingClientRect();
          return { found: true, total: list.length, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`
      : `(() => {
          const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const el = res.snapshotItem(${nth});
          if (!el || !(el instanceof Element)) return { found: false, total: res.snapshotLength };
          const r = el.getBoundingClientRect();
          return { found: true, total: res.snapshotLength, x: r.left + r.width / 2, y: r.top + r.height / 2 };
        })()`;

    const coordResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script, returnByValue: true,
    })) as { result: { value: { found: boolean; total: number; x?: number; y?: number } | null } };

    const resolved = coordResult.result.value;
    if (!resolved || !resolved.found) {
      throw new Error(`Input element not found: ${selector}${nth ? ` (nth=${nth}, matches=${resolved?.total ?? 0})` : ''}`);
    }
    const x = resolved.x!;
    const y = resolved.y!;
    const isMac = await isMacPlatform();
    // CDP modifier bits: Alt=1, Control=2, Meta=4, Shift=8
    const selectAllModifier = isMac ? 4 : 2;

    // Real mouse click — moves cursor visibly and establishes OS focus so key events land here
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await randomDelay(20, 60);
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await randomDelay(30, 70);
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

    // Clear existing text via Cmd+A (macOS) / Ctrl+A (others) then Delete — visible like a real action
    if (clearFirst || text === '') {
      await randomDelay(50, 120);
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAllModifier });
      await randomDelay(20, 50);
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAllModifier });
      await randomDelay(30, 70);
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await randomDelay(20, 50);
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    }

    await randomDelay(100, 200);

    // Type text through the real input pipeline with slight jitter between characters
    for (const char of text) {
      await debuggerManager.sendCommand(tabId, 'Input.insertText', { text: char });
      await randomDelay(40, 80);
    }

    // Submit via Enter key — works because OS focus is on this input
    // IMPORTANT: For Enter key we MUST send "\r" (carriage return) NOT "\n" to trigger form submission
    if (submit) {
      await randomDelay(80, 150);
      const enterBase = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 };
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', ...enterBase });
      await randomDelay(30, 60);
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'char', text: '\r', modifiers: 0 });
      await randomDelay(30, 60);
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', ...enterBase });
    }

    return { selector, typed: text.length, cleared: clearFirst, submitted: submit };
  });

  /**
   * Typing into autocomplete / combobox inputs (Ant Design AutoComplete, MUI Autocomplete,
   * Headless UI Combobox, etc.) requires selecting a dropdown item — pressing Enter on the
   * raw typed text either dismisses the menu or submits the wrong filter. This handler
   * types a prefix, waits for the options list to appear, then dispatches a real click on
   * the option whose visible text matches.
   */
  registerHandler('select_from_autocomplete', async (params, tabId) => {
    const {
      selector,
      selectorType = 'css',
      text,
      optionText,
      optionSelector,
      nth = 0,
      waitMs = 1200,
      clearFirst = true,
    } = params as {
      selector: string;
      selectorType?: 'css' | 'xpath';
      text: string;       // what to type to trigger the dropdown
      optionText?: string;// visible text of the option to choose (substring, case-insensitive)
      optionSelector?: string; // fallback CSS selector for the option container (e.g. '.ant-select-item')
      nth?: number;
      waitMs?: number;
      clearFirst?: boolean;
    };

    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'Runtime');

    // Reuse the same focus/clear/type path as input_and_type, but inline to keep this handler self-contained.
    const locateScript = selectorType === 'css'
      ? `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`
      : `(() => { const res = document.evaluate(${JSON.stringify(selector)}, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); const el = res.singleNodeValue; if (!el || !(el instanceof Element)) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`;
    const located = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: locateScript, returnByValue: true,
    })) as { result: { value: { x: number; y: number } | null } };
    if (!located.result.value) throw new Error(`Autocomplete input not found: ${selector}`);
    const { x, y } = located.result.value;
    const isMac = await isMacPlatform();
    const selectAllModifier = isMac ? 4 : 2;

    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });

    if (clearFirst) {
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAllModifier });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: selectAllModifier });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp',   key: 'Delete', code: 'Delete', windowsVirtualKeyCode: 46 });
    }
    for (const char of text) {
      await debuggerManager.sendCommand(tabId, 'Input.insertText', { text: char });
      await randomDelay(30, 70);
    }

    // Wait for the dropdown to populate. We poll for at least one candidate option
    // matching either the provided optionSelector or a set of common framework classes.
    // Apps sometimes render a custom popup (e.g. Tailwind floating panels with a
    // `z-dropdown` utility class) so we also match any element whose own class
    // contains "dropdown" / "popup" and whose direct children hold the options.
    const dropdownSelector = optionSelector || [
      '.ant-select-item-option',
      '.ant-cascader-menu-item',
      '[role="option"]',
      '[role="listbox"] > *',
      '.MuiAutocomplete-option',
      '[data-reach-combobox-option]',
      '[class*="z-dropdown"] > *',
      '[class*="-dropdown-menu"] > *',
      '[class*="popover"] [role="button"]',
    ].join(',');

    const matchText = (optionText ?? text).toLowerCase();
    const pollExpr = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(dropdownSelector)}));
      const want = ${JSON.stringify(matchText)};
      const matches = nodes.filter(n => (n.textContent || '').toLowerCase().includes(want));
      return { total: nodes.length, matches: matches.length };
    })()`;

    const deadline = Date.now() + Math.max(200, waitMs);
    let polled: { total: number; matches: number } | null = null;
    while (Date.now() < deadline) {
      const res = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: pollExpr, returnByValue: true,
      })) as { result: { value: { total: number; matches: number } } };
      polled = res.result.value;
      if (polled && polled.matches > 0) break;
      await randomDelay(80, 160);
    }

    if (!polled || polled.matches === 0) {
      return { typed: text, matched: 0, selectedText: null, warning: 'No dropdown options matched. Try widening `optionText` or a shorter prefix.' };
    }

    // Click the Nth matching option. We use a fresh querySelectorAll + direct el.click()
    // because dropdown items are often rendered above all other stacking contexts and
    // CDP Bézier mouse movement can miss or hit the input behind them.
    const clickScript = `(() => {
      const nodes = Array.from(document.querySelectorAll(${JSON.stringify(dropdownSelector)}));
      const want = ${JSON.stringify(matchText)};
      const matches = nodes.filter(n => (n.textContent || '').toLowerCase().includes(want));
      const target = matches[${nth}];
      if (!target) return { ok: false, total: matches.length };
      const r = target.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width/2, clientY: r.top + r.height/2 };
      target.dispatchEvent(new MouseEvent('mousedown', opts));
      target.dispatchEvent(new MouseEvent('mouseup', opts));
      if (typeof target.click === 'function') target.click(); else target.dispatchEvent(new MouseEvent('click', opts));
      return { ok: true, total: matches.length, text: (target.textContent || '').trim().substring(0, 200) };
    })()`;
    const res = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: clickScript, returnByValue: true,
    })) as { result: { value: { ok: boolean; total: number; text?: string } } };
    return {
      typed: text,
      matched: res.result.value.total,
      selectedText: res.result.value.text || null,
    };
  });
}
