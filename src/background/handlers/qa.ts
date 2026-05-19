import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';
import { getConsoleLogs, clearConsoleLogs } from './devtools-console.js';
import { getNetworkLogs, getNetworkErrors, clearNetworkLogs, ensureNetworkListeners } from './devtools-network.js';

export function registerQaHandlers(): void {
  registerHandler('assert_element', async (params, tabId) => {
    const { assertion, selector, expected, attributeName, className } = params as {
      assertion: string;
      selector: string;
      expected?: string;
      attributeName?: string;
      className?: string;
    };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const assertions = {
        exists: () => !!el,
        notExists: () => !el,
        isVisible: () => !!el && el.offsetParent !== null && el.getBoundingClientRect().width > 0,
        isNotVisible: () => !el || el.offsetParent === null || el.getBoundingClientRect().width === 0,
        isEnabled: () => !!el && !el.disabled,
        isDisabled: () => !!el && el.disabled,
        isFocused: () => !!el && document.activeElement === el,
        isNotFocused: () => !el || document.activeElement !== el,
        isChecked: () => !!el && el.checked,
        isNotChecked: () => !el || !el.checked,
        isSelected: () => !!el && el.selected,
        isNotSelected: () => !el || !el.selected,
        textEquals: () => !!el && el.textContent.trim() === ${JSON.stringify(expected || '')},
        textContains: () => !!el && el.textContent.trim().includes(${JSON.stringify(expected || '')}),
        valueEquals: () => !!el && el.value === ${JSON.stringify(expected || '')},
        hasAttribute: () => !!el && el.hasAttribute(${JSON.stringify(attributeName || '')}),
        hasClass: () => !!el && el.classList.contains(${JSON.stringify(className || '')}),
        isValid: () => !!el && el.checkValidity ? el.checkValidity() : true,
        isInvalid: () => !!el && el.checkValidity ? !el.checkValidity() : false,
      };
      const fn = assertions[${JSON.stringify(assertion)}];
      const passed = fn ? fn() : false;
      return {
        passed,
        assertion: ${JSON.stringify(assertion)},
        selector: ${JSON.stringify(selector)},
        actual: el ? (el.textContent?.trim().substring(0, 200) || el.value || '') : '(not found)',
        expected: ${JSON.stringify(expected || null)},
        message: passed ? 'Assertion passed' : 'Assertion failed',
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('check_form_validity', async (params, tabId) => {
    const { selector, checkAll = true } = params as { selector: string; checkAll?: boolean };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const root = document.querySelector(${JSON.stringify(selector)});
      if (!root) return { error: 'Form not found' };
      const elements = ${JSON.stringify(checkAll)}
        ? Array.from(root.querySelectorAll('input, select, textarea'))
        : [root];
      return elements.map(el => {
        const valid = el.checkValidity ? el.checkValidity() : true;
        const validity = el.validity ? {
          valueMissing: el.validity.valueMissing,
          typeMismatch: el.validity.typeMismatch,
          patternMismatch: el.validity.patternMismatch,
          tooLong: el.validity.tooLong,
          tooShort: el.validity.tooShort,
          rangeUnderflow: el.validity.rangeUnderflow,
          rangeOverflow: el.validity.rangeOverflow,
          stepMismatch: el.validity.stepMismatch,
          badInput: el.validity.badInput,
          customError: el.validity.customError,
          valid: el.validity.valid,
        } : {};
        return {
          selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.name ? '[name="' + el.name + '"]' : ''),
          valid,
          validationMessage: el.validationMessage || '',
          validity,
        };
      });
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('tab_to_next', async (params, tabId) => {
    const { direction = 'next', shift = false } = params as { direction?: 'next' | 'previous'; shift?: boolean };
    await debuggerManager.ensureAttached(tabId);

    const beforeScript = `(() => {
      const el = document.activeElement;
      return el && el !== document.body ? {
        selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
        tagName: el.tagName,
        text: el.textContent?.trim().substring(0, 100),
      } : null;
    })()`;

    const beforeResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: beforeScript,
      returnByValue: true,
    })) as { result: { value: unknown } };
    const previousFocus = beforeResult.result.value;

    await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Tab',
      code: 'Tab',
      keyIdentifier: 'U+0009',
      shiftKey: direction === 'previous' || shift,
    });
    await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Tab',
      code: 'Tab',
      keyIdentifier: 'U+0009',
      shiftKey: direction === 'previous' || shift,
    });

    await new Promise((r) => setTimeout(r, 50));

    const afterScript = `(() => {
      const el = document.activeElement;
      return el && el !== document.body ? {
        selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
        tagName: el.tagName,
        text: el.textContent?.trim().substring(0, 100),
      } : null;
    })()`;

    const afterResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: afterScript,
      returnByValue: true,
    })) as { result: { value: unknown } };
    const currentFocus = afterResult.result.value;

    const wrapped = JSON.stringify(previousFocus) === JSON.stringify(currentFocus);

    return { previousFocus, currentFocus, wrapped };
  });

  registerHandler('set_input_files', async (params, tabId) => {
    const { selector, files } = params as { selector: string; files: string[] };
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'DOM');

    const doc = (await debuggerManager.sendCommand(tabId, 'DOM.getDocument')) as { root: { nodeId: number } };
    const queryResult = (await debuggerManager.sendCommand(tabId, 'DOM.querySelector', {
      nodeId: doc.root.nodeId,
      selector,
    })) as { nodeId: number };

    if (!queryResult.nodeId) {
      throw new Error(`Element not found: ${selector}`);
    }

    await debuggerManager.sendCommand(tabId, 'DOM.setFileInputFiles', {
      nodeId: queryResult.nodeId,
      files,
    });

    return { selector, filesSet: files.length };
  });

  registerHandler('emulate_network_conditions', async (params, tabId) => {
    const { offline = false, latency, downloadThroughput, uploadThroughput, reset } = params as {
      offline?: boolean;
      latency?: number;
      downloadThroughput?: number;
      uploadThroughput?: number;
      reset?: boolean;
    };
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'Network');

    if (reset) {
      await debuggerManager.sendCommand(tabId, 'Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      return { reset: true };
    }

    await debuggerManager.sendCommand(tabId, 'Network.emulateNetworkConditions', {
      offline,
      latency: latency ?? 0,
      downloadThroughput: downloadThroughput ?? -1,
      uploadThroughput: uploadThroughput ?? -1,
    });

    return { offline, latency: latency ?? 0, downloadThroughput: downloadThroughput ?? -1, uploadThroughput: uploadThroughput ?? -1 };
  });

  const interceptRules = new Map<number, Array<{ action: string; urlPattern?: string; method?: string; statusCode?: number; responseBody?: string; responseHeaders?: Record<string, string> }>>();

  registerHandler('intercept_requests', async (params, tabId) => {
    const { action, urlPattern, method, statusCode, responseBody, responseHeaders } = params as {
      action: 'block' | 'modify' | 'allow' | 'clear';
      urlPattern?: string;
      method?: string;
      statusCode?: number;
      responseBody?: string;
      responseHeaders?: Record<string, string>;
    };
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.enableDomain(tabId, 'Fetch');

    if (action === 'clear') {
      interceptRules.delete(tabId);
      await debuggerManager.sendCommand(tabId, 'Fetch.disable');
      return { cleared: true };
    }

    const rules = interceptRules.get(tabId) || [];
    rules.push({ action, urlPattern, method, statusCode, responseBody, responseHeaders });
    interceptRules.set(tabId, rules);

    await debuggerManager.sendCommand(tabId, 'Fetch.enable', {
      patterns: [{ urlPattern: urlPattern || '*', requestStage: 'Request' }],
    });

    // Set up listener if not already
    chrome.debugger.onEvent.addListener(async (source, methodName, cdpParams: any) => {
      if (source.tabId !== tabId || methodName !== 'Fetch.requestPaused') return;
      const requestId = cdpParams.requestId;
      const reqUrl = cdpParams.request?.url || '';
      const reqMethod = cdpParams.request?.method || '';

      for (const rule of rules) {
        if (rule.urlPattern && !reqUrl.includes(rule.urlPattern)) continue;
        if (rule.method && reqMethod !== rule.method) continue;

        if (rule.action === 'block') {
          await debuggerManager.sendCommand(tabId, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' });
          return;
        }
        if (rule.action === 'modify') {
          await debuggerManager.sendCommand(tabId, 'Fetch.fulfillRequest', {
            requestId,
            responseCode: rule.statusCode || 200,
            responseHeaders: rule.responseHeaders
              ? Object.entries(rule.responseHeaders).map(([k, v]) => ({ name: k, value: v }))
              : [],
            body: rule.responseBody ? btoa(rule.responseBody) : '',
          });
          return;
        }
      }

      await debuggerManager.sendCommand(tabId, 'Fetch.continueRequest', { requestId });
    });

    return { action, urlPattern, rulesCount: rules.length };
  });

  registerHandler('snapshot_page_state', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const html = document.documentElement.outerHTML;
      const localStorage = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        localStorage[k] = localStorage.getItem(k);
      }
      const sessionStorage = {};
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        sessionStorage[k] = sessionStorage.getItem(k);
      }
      const formValues = {};
      for (const input of document.querySelectorAll('input, textarea, select')) {
        if (input.id || input.name) {
          formValues[input.id || input.name] = input.value;
        }
      }
      return {
        url: window.location.href,
        html,
        localStorage,
        sessionStorage,
        scrollPosition: { x: window.scrollX, y: window.scrollY },
        formValues,
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    const cookies = await chrome.cookies.getAll({ url: (await chrome.tabs.get(tabId)).url });

    return {
      ...(result.result.value as Record<string, unknown>),
      cookies,
    };
  });

  registerHandler('restore_page_state', async (params, tabId) => {
    const { snapshot } = params as {
      snapshot: {
        url: string;
        html?: string;
        localStorage?: Record<string, string>;
        sessionStorage?: Record<string, string>;
        cookies?: any[];
        scrollPosition?: { x: number; y: number };
      };
    };

    await chrome.tabs.update(tabId, { url: snapshot.url });
    await new Promise((r) => setTimeout(r, 1000));
    await debuggerManager.ensureAttached(tabId);

    if (snapshot.localStorage) {
      const lsScript = `(() => {
        for (const [k, v] of Object.entries(${JSON.stringify(snapshot.localStorage)})) {
          localStorage.setItem(k, v);
        }
      })()`;
      await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', { expression: lsScript });
    }

    if (snapshot.sessionStorage) {
      const ssScript = `(() => {
        for (const [k, v] of Object.entries(${JSON.stringify(snapshot.sessionStorage)})) {
          sessionStorage.setItem(k, v);
        }
      })()`;
      await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', { expression: ssScript });
    }

    if (snapshot.cookies) {
      for (const cookie of snapshot.cookies) {
        try {
          await chrome.cookies.set({
            url: snapshot.url,
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
          });
        } catch {
          // Ignore cookie set errors
        }
      }
    }

    if (snapshot.html) {
      await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `document.documentElement.outerHTML = ${JSON.stringify(snapshot.html)}`,
      });
    }

    if (snapshot.scrollPosition) {
      await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `window.scrollTo(${snapshot.scrollPosition.x}, ${snapshot.scrollPosition.y})`,
      });
    }

    return { restored: true };
  });

  registerHandler('wait_for_condition', async (params, tabId) => {
    const { expression, timeout = 10000, interval = 500 } = params as {
      expression: string;
      timeout?: number;
      interval?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    // Wrap user expression so any thrown error OR non-truthy / undefined return
    // resolves to false instead of surfacing as a Runtime.evaluate exception.
    const safeEval = `(() => { try { return Boolean((function(){ return (${expression}); })()); } catch (e) { return false; } })()`;
    const script = `(() => {
      return new Promise((resolve) => {
        const deadline = Date.now() + ${timeout};
        const poll = () => {
          let ok = false;
          try { ok = ${safeEval}; } catch (e) { ok = false; }
          if (ok) return resolve({ conditionMet: true, elapsedMs: ${timeout} - (deadline - Date.now()) });
          if (Date.now() > deadline) return resolve({ conditionMet: false, elapsedMs: ${timeout} });
          setTimeout(poll, ${interval});
        };
        poll();
      });
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('assert_no_console_errors', async (params, tabId) => {
    const { level = 'error', clear = false } = params as { level?: string; clear?: boolean };
    await debuggerManager.ensureAttached(tabId);
    const logs = getConsoleLogs(tabId, level);
    const passed = logs.length === 0;
    if (clear) {
      clearConsoleLogs(tabId);
    }
    return {
      passed,
      errorCount: logs.length,
      errors: logs.slice(0, 50),
      message: passed ? `No ${level} console entries found` : `Found ${logs.length} ${level} console entries`,
    };
  });

  registerHandler('assert_no_network_errors', async (params, tabId) => {
    const { clear = false } = params as { clear?: boolean };
    await debuggerManager.ensureAttached(tabId);
    ensureNetworkListeners(tabId);
    const errors = getNetworkErrors(tabId);
    const passed = errors.length === 0;
    if (clear) {
      clearNetworkLogs(tabId);
    }
    return {
      passed,
      errorCount: errors.length,
      errors: errors.slice(0, 50),
      message: passed ? 'No network errors found' : `Found ${errors.length} network errors`,
    };
  });

  registerHandler('get_network_errors', async (params, tabId) => {
    const { clear = false } = params as { clear?: boolean };
    await debuggerManager.ensureAttached(tabId);
    ensureNetworkListeners(tabId);
    const errors = getNetworkErrors(tabId);
    if (clear) {
      clearNetworkLogs(tabId);
    }
    return errors;
  });

  registerHandler('stress_test_refresh', async (params, tabId) => {
    const { iterations = 5, assertionScript, waitAfterReload = 2000, bypassCache = true } = params as {
      iterations?: number;
      assertionScript?: string;
      waitAfterReload?: number;
      bypassCache?: boolean;
    };
    await debuggerManager.ensureAttached(tabId);

    const results = [];
    for (let i = 0; i < iterations; i++) {
      await chrome.tabs.reload(tabId, { bypassCache });
      await new Promise((r) => setTimeout(r, waitAfterReload));
      await debuggerManager.ensureAttached(tabId);

      let passed = true;
      let error = null;
      let resultValue = null;

      if (assertionScript) {
        try {
          const evalResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
            expression: `(() => { try { return { passed: !!(${assertionScript}), result: ${assertionScript} }; } catch (e) { return { passed: false, error: e.message }; } })()`,
            returnByValue: true,
          })) as { result: { value: { passed: boolean; result?: unknown; error?: string } } };
          passed = evalResult.result.value.passed;
          resultValue = evalResult.result.value.result;
          error = evalResult.result.value.error || null;
        } catch (e: any) {
          passed = false;
          error = e.message;
        }
      }

      results.push({ iteration: i + 1, passed, error, result: resultValue });
    }

    const allPassed = results.every((r) => r.passed);
    return { iterations, allPassed, bypassCache, results };
  });

  registerHandler('assert_css_property', async (params, tabId) => {
    const { selector, property, expected } = params as { selector: string; property: string; expected: string };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { passed: false, actual: null, message: 'Element not found' };
      const value = getComputedStyle(el).getPropertyValue(${JSON.stringify(property)}).trim();
      const passed = value === ${JSON.stringify(expected)};
      return { passed, actual: value, expected: ${JSON.stringify(expected)}, property, selector, message: passed ? 'CSS property matches' : \`Expected "${expected}" but got "\${value}"\` };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('assert_network_request_made', async (params, tabId) => {
    const { urlPattern, method, minCount = 1 } = params as {
      urlPattern?: string;
      method?: string;
      minCount?: number;
    };
    await debuggerManager.ensureAttached(tabId);
    ensureNetworkListeners(tabId);
    const logs = getNetworkLogs(tabId);
    const matched = logs.filter((e) => {
      if (urlPattern && !e.url.toLowerCase().includes(urlPattern.toLowerCase())) return false;
      if (method && e.method.toUpperCase() !== method.toUpperCase()) return false;
      return true;
    });
    const passed = matched.length >= minCount;
    return {
      passed,
      matchedCount: matched.length,
      minCount,
      requests: matched.slice(0, 20),
      message: passed ? `Found ${matched.length} matching requests` : `Expected at least ${minCount} matching requests, found ${matched.length}`,
    };
  });

  registerHandler('assert_page_load_time', async (params, tabId) => {
    const { threshold = 3000 } = params as { threshold?: number };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return { passed: false, loadTime: null, message: 'Navigation timing not available' };
      const loadTime = nav.loadEventEnd - nav.startTime;
      const passed = loadTime <= ${threshold};
      return { passed, loadTime, threshold: ${threshold}, message: passed ? \`Page loaded in \${loadTime}ms\` : \`Page load time \${loadTime}ms exceeds threshold \${threshold}ms\` };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_all_issues', async (params, tabId) => {
    const { includeConsole = true, includeNetwork = true, includeResources = true, clearAfter = false } = params as {
      includeConsole?: boolean;
      includeNetwork?: boolean;
      includeResources?: boolean;
      clearAfter?: boolean;
    };

    // Try to attach debugger, but don't fail entirely if another debugger is attached
    let debuggerAvailable = false;
    try {
      await debuggerManager.ensureAttached(tabId);
      debuggerAvailable = true;
    } catch (err: any) {
      if (err.message?.includes('Another debugger is already attached')) {
        // Debugger is attached by something else (e.g. Chrome DevTools) — we can still try to use it
        debuggerAvailable = true;
      }
      // If it's a different error, we'll proceed without resource inspection
    }

    const result: Record<string, any> = { timestamp: Date.now(), debuggerAvailable };

    if (includeConsole) {
      const consoleErrors = getConsoleLogs(tabId, 'error');
      const consoleWarnings = getConsoleLogs(tabId, 'warn');
      result.console = {
        errorCount: consoleErrors.length,
        warnCount: consoleWarnings.length,
        errors: consoleErrors.slice(0, 20),
        warnings: consoleWarnings.slice(0, 20),
      };
    }

    if (includeNetwork) {
      ensureNetworkListeners(tabId);
      const networkErrors = getNetworkErrors(tabId);
      result.network = {
        errorCount: networkErrors.length,
        errors: networkErrors.slice(0, 20),
      };
    }

    if (includeResources && debuggerAvailable) {
      try {
        const resourceScript = `(() => {
          const issues = [];
          for (const img of document.querySelectorAll('img')) {
            if (img.naturalWidth === 0 && img.naturalHeight === 0 && !img.complete) {
              issues.push({ type: 'image', url: img.src, issue: 'Failed to load' });
            }
          }
          for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
            try {
              if (link.sheet && link.sheet.cssRules === null) {
                issues.push({ type: 'stylesheet', url: link.href, issue: 'CSS rules inaccessible (possible CORS error)' });
              }
            } catch (e) {
              issues.push({ type: 'stylesheet', url: link.href, issue: 'CORS error accessing stylesheet' });
            }
          }
          if (document.fonts) {
            document.fonts.forEach(font => {
              if (font.status === 'error') {
                issues.push({ type: 'font', url: font.family, issue: 'Font failed to load' });
              }
            });
          }
          return issues;
        })()`;
        const resourceResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
          expression: resourceScript,
          returnByValue: true,
        })) as { result: { value: any[] } };
        result.resources = {
          issueCount: resourceResult.result.value.length,
          issues: resourceResult.result.value.slice(0, 20),
        };
      } catch (err: any) {
        result.resources = {
          issueCount: 0,
          issues: [],
          error: 'Could not inspect resources: ' + err.message,
        };
      }
    }

    result.totalIssues = (result.console?.errorCount || 0) + (result.console?.warnCount || 0) + (result.network?.errorCount || 0) + (result.resources?.issueCount || 0);
    result.hasIssues = result.totalIssues > 0;

    if (clearAfter) {
      clearConsoleLogs(tabId);
      clearNetworkLogs(tabId);
    }

    return result;
  });

  // ---------------------------------------------------------------------------
  // Advanced QA helpers for detecting common SPA / UI bugs
  // ---------------------------------------------------------------------------

  /**
   * test_multi_tab_sync: verify that localStorage (or sessionStorage / cookies)
   * changes in one tab are reflected in another tab opened to the same URL.
   */
  registerHandler('test_multi_tab_sync', async (params, tabId) => {
    const { storageType = 'localStorage', keyToSet = '_browserGenieTestKey', valueToSet = 'sync-test-value', waitMs = 2000 } = params as {
      storageType?: 'localStorage' | 'sessionStorage' | 'cookies';
      keyToSet?: string;
      valueToSet?: string;
      waitMs?: number;
    };

    const originalTab = await chrome.tabs.get(tabId);
    const testUrl = originalTab.url || 'about:blank';

    // Open a second tab to the same URL
    const newTab = await chrome.tabs.create({ url: testUrl, active: false });
    if (!newTab.id) throw new Error('Failed to create second tab');
    const newTabId = newTab.id;

    await new Promise((r) => setTimeout(r, waitMs));

    // Set value in original tab
    const setScript = `(() => {
      try {
        if (${JSON.stringify(storageType)} === 'localStorage') localStorage.setItem(${JSON.stringify(keyToSet)}, ${JSON.stringify(valueToSet)});
        else if (${JSON.stringify(storageType)} === 'sessionStorage') sessionStorage.setItem(${JSON.stringify(keyToSet)}, ${JSON.stringify(valueToSet)});
        else document.cookie = ${JSON.stringify(`${keyToSet}=${valueToSet}; path=/`)}
        return { success: true };
      } catch (e) {
        return { success: false, error: e.message };
      }
    })()`;
    await debuggerManager.ensureAttached(tabId);
    await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', { expression: setScript, returnByValue: true });

    // Wait briefly for broadcast (storage events are immediate on same-origin)
    await new Promise((r) => setTimeout(r, 500));

    // Check second tab
    await debuggerManager.ensureAttached(newTabId);
    const checkScript = `(() => {
      try {
        let value = null;
        if (${JSON.stringify(storageType)} === 'localStorage') value = localStorage.getItem(${JSON.stringify(keyToSet)});
        else if (${JSON.stringify(storageType)} === 'sessionStorage') value = sessionStorage.getItem(${JSON.stringify(keyToSet)});
        else {
          const match = document.cookie.match(new RegExp('(^| )' + ${JSON.stringify(keyToSet)} + '=([^;]+)'));
          value = match ? match[2] : null;
        }
        return { value, synced: value === ${JSON.stringify(valueToSet)} };
      } catch (e) {
        return { value: null, synced: false, error: e.message };
      }
    })()`;
    const checkResult = (await debuggerManager.sendCommand(newTabId, 'Runtime.evaluate', {
      expression: checkScript,
      returnByValue: true,
    })) as { result: { value: { value: string | null; synced: boolean; error?: string } } };

    // Cleanup: remove the test key and close the second tab
    const cleanupScript = `(() => {
      if (${JSON.stringify(storageType)} === 'localStorage') localStorage.removeItem(${JSON.stringify(keyToSet)});
      else if (${JSON.stringify(storageType)} === 'sessionStorage') sessionStorage.removeItem(${JSON.stringify(keyToSet)});
      else document.cookie = ${JSON.stringify(`${keyToSet}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`)};
    })()`;
    await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', { expression: cleanupScript }).catch(() => {});
    await chrome.tabs.remove(newTabId).catch(() => {});

    return {
      synced: checkResult.result.value.synced,
      originalValue: valueToSet,
      observedValue: checkResult.result.value.value,
      error: checkResult.result.value.error || null,
    };
  });

  /**
   * test_drag_reorder: determine whether a container (list, grid, table, etc.)
   * supports drag-and-drop reordering by looking for sortable handles, CSS
   * cursor styles, draggable attributes, or dragstart event listeners.
   * Works on any website with sortable lists, kanban boards, galleries, etc.
   */
  registerHandler('test_drag_reorder', async (params, tabId) => {
    const { containerSelector } = params as { containerSelector?: string };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const container = ${JSON.stringify(containerSelector)}
        ? document.querySelector(${JSON.stringify(containerSelector)})
        : document.querySelector('ul, ol, [role="list"], .sortable, .draggable, [class*="sortable"], [class*="draggable"]');
      if (!container) return { hasSortableContainer: false, reorderable: false, reason: 'No sortable container found' };
      const items = Array.from(container.children);
      const results = items.map((el, i) => {
        const style = getComputedStyle(el);
        const hasGrabCursor = style.cursor === 'grab' || style.cursor === 'move';
        const hasHandle = !!el.querySelector('[class*="handle"], [class*="drag"], .sortable-handle, .drag-handle');
        const hasDraggable = el.getAttribute('draggable') === 'true';
        // Check for common drag-listener patterns across popular libraries
        const hasDragListener = typeof el.ondragstart === 'function' ||
          !!(window.jQuery && window.jQuery(el).data('ui-sortable')) ||
          !!(window.Sortable && window.Sortable.get && window.Sortable.get(el));
        return { index: i, tag: el.tagName, hasGrabCursor, hasHandle, hasDraggable, hasDragListener };
      });
      const anyReorderable = results.some(r => r.hasGrabCursor || r.hasHandle || r.hasDraggable || r.hasDragListener);
      return {
        hasSortableContainer: true,
        itemCount: items.length,
        reorderable: anyReorderable,
        items: results.slice(0, 20),
        reason: anyReorderable ? 'Detected drag affordances' : 'No drag handles, cursors, or listeners found on children',
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };
    return result.result.value;
  });

  /**
   * test_long_text_overflow: type a very long string into an input/editable
   * and inspect the rendered output for clipping, horizontal overflow, or
   * word-breaking artifacts.
   */
  registerHandler('test_long_text_overflow', async (params, tabId) => {
    const { inputSelector, text, submit = true } = params as {
      inputSelector: string;
      text?: string;
      submit?: boolean;
    };
    const longText = text || 'Supercalifragilisticexpialidocious pneumonoultramicroscopicsilicovolcanoconiosis antidisestablishmentarianism floccinaucinihilipilification';
    await debuggerManager.ensureAttached(tabId);

    // Type the long text
    const typeScript = `(() => {
      const el = document.querySelector(${JSON.stringify(inputSelector)});
      if (!el) return { error: 'Input not found' };
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.focus();
        el.value = ${JSON.stringify(longText)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = ${JSON.stringify(longText)};
      }
      return { success: true, tag: el.tagName, textLength: ${JSON.stringify(longText)}.length };
    })()`;
    const typeResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: typeScript,
      returnByValue: true,
    })) as { result: { value: { error?: string; success?: boolean; tag?: string; textLength?: number } } };

    if (typeResult.result.value?.error) {
      throw new Error(typeResult.result.value.error);
    }

    if (submit) {
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
      await new Promise((r) => setTimeout(r, 500));
    }

    // Inspect rendered text containers for overflow / clipping / word-break issues
    const inspectScript = `(() => {
      const els = Array.from(document.querySelectorAll('p, span, li, td, label, div'));
      const issues = [];
      for (const el of els) {
        const textContent = el.textContent || '';
        if (!textContent.includes(${JSON.stringify(longText).slice(1, -1).substring(0, 20)})) continue;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const hasOverflowX = style.overflowX === 'hidden' && (el.scrollWidth > rect.width);
        const hasOverflowY = style.overflowY === 'hidden' && (el.scrollHeight > rect.height);
        const wordBreak = style.wordBreak;
        const whiteSpace = style.whiteSpace;
        // Detect mid-word truncation (white-space nowrap with overflow hidden)
        const midWordTruncation = whiteSpace === 'nowrap' && style.overflow === 'hidden' && style.textOverflow === 'ellipsis';
        issues.push({
          selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.split(' ')[0] : ''),
          textSnippet: textContent.substring(0, 80),
          hasOverflowX,
          hasOverflowY,
          midWordTruncation,
          wordBreak,
          whiteSpace,
          scrollWidth: el.scrollWidth,
          clientWidth: rect.width,
        });
      }
      return { issues: issues.slice(0, 10), issueCount: issues.length };
    })()`;

    const inspectResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: inspectScript,
      returnByValue: true,
    })) as { result: { value: Record<string, unknown> } };

    return {
      typedLength: longText.length,
      inputFound: true,
      ...(inspectResult.result.value || {}),
    };
  });

  /**
   * test_glyph_failure_race: refresh the page multiple times and inspect
   * all rendered text nodes for replacement / tofu characters (e.g. �, □)
   * that indicate font-loading race conditions or missing glyphs.
   */
  registerHandler('test_glyph_failure_race', async (params, tabId) => {
    const { iterations = 5, waitAfterReload = 1500, selectors } = params as {
      iterations?: number;
      waitAfterReload?: number;
      selectors?: string[];
    };

    const failures: Array<{ iteration: number; badGlyphs: number; sampleElements: string[] }> = [];
    const badCharRegex = /[\uFFFD\u25A1\u25AF\u2B1C\u26F6]/;
    const targetSelectors = selectors || ['i', '.icon', '.fa', '.material-icons', '[class*="icon"]', 'span', 'button'];

    for (let i = 0; i < iterations; i++) {
      await chrome.tabs.reload(tabId, { bypassCache: true });
      await new Promise((r) => setTimeout(r, waitAfterReload));
      await debuggerManager.ensureAttached(tabId);

      const script = `(() => {
        const badCharRegex = /[\\uFFFD\\u25A1\\u25AF\\u2B1C\\u26F6]/;
        const els = Array.from(document.querySelectorAll(${JSON.stringify(targetSelectors.join(', '))}));
        const bad = [];
        for (const el of els) {
          const text = (el.textContent || '').trim();
          if (badCharRegex.test(text)) {
            bad.push(el.tagName.toLowerCase() + (el.className ? '.' + el.className.split(' ').slice(0,2).join('.') : ''));
          }
        }
        // Also scan all text nodes in body for replacement characters
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (badCharRegex.test(node.textContent || '')) {
            const parent = node.parentElement;
            if (parent) {
              bad.push('text:' + parent.tagName.toLowerCase() + (parent.className ? '.' + parent.className.split(' ')[0] : ''));
            }
          }
        }
        // Deduplicate
        const unique = [...new Set(bad)];
        return { badCount: unique.length, samples: unique.slice(0, 10) };
      })()`;
      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: { badCount: number; samples: string[] } } };

      if (result.result.value.badCount > 0) {
        failures.push({ iteration: i + 1, badGlyphs: result.result.value.badCount, sampleElements: result.result.value.samples });
      }
    }

    return {
      iterations,
      failures,
      passed: failures.length === 0,
      message: failures.length === 0
        ? 'No font glyph failures detected across all refreshes'
        : `Detected ${failures.length} refresh cycles with font glyph failures`,
    };
  });

  /**
   * test_inline_edit_empty: double-click an editable element (e.g. a list item
   * label, a table cell, or any contenteditable), clear its text, submit
   * (blur / Enter), and check whether the element still exists or was removed.
   * This detects the common UX bug where editing an item to empty does NOT
   * delete it, leaving a blank entry in the list/table.
   */
  registerHandler('test_inline_edit_empty', async (params, tabId) => {
    const { elementSelector, useEnterToSubmit = true } = params as {
      elementSelector: string;
      useEnterToSubmit?: boolean;
    };
    await debuggerManager.ensureAttached(tabId);

    // Check element exists before edit
    const beforeScript = `(() => {
      const el = document.querySelector(${JSON.stringify(elementSelector)});
      return { exists: !!el, text: el ? (el.textContent || el.value || '').trim() : null };
    })()`;
    const before = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: beforeScript, returnByValue: true,
    })) as { result: { value: { exists: boolean; text: string | null } } };

    if (!before.result.value.exists) {
      throw new Error(`Element not found: ${elementSelector}`);
    }

    // Double-click to trigger edit mode (works for labels, list items, table cells, etc.)
    const dblClickScript = `(() => {
      const el = document.querySelector(${JSON.stringify(elementSelector)});
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy };
      el.dispatchEvent(new MouseEvent('dblclick', opts));
      return true;
    })()`;
    await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', { expression: dblClickScript, returnByValue: true });
    await new Promise((r) => setTimeout(r, 300));

    // Clear any focused input / contenteditable and submit empty
    const clearScript = `(() => {
      const active = document.activeElement;
      if (!active) return { cleared: false, reason: 'No focused element after dblclick' };
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
        active.value = '';
        active.dispatchEvent(new Event('input', { bubbles: true }));
        return { cleared: true, tag: active.tagName, isInput: true };
      }
      if (active.isContentEditable) {
        active.textContent = '';
        return { cleared: true, tag: active.tagName, isContentEditable: true };
      }
      // Fallback: try to find an input sibling or child that appeared
      const sibling = active.querySelector('input.edit, textarea.edit, [contenteditable]') ||
        document.querySelector('input.edit, textarea.edit, [contenteditable]');
      if (sibling && (active.contains(sibling) || sibling === active)) {
        sibling.focus();
        if (sibling.tagName === 'INPUT' || sibling.tagName === 'TEXTAREA') {
          sibling.value = '';
        } else {
          sibling.textContent = '';
        }
        sibling.dispatchEvent(new Event('input', { bubbles: true }));
        return { cleared: true, tag: sibling.tagName, fallback: true };
      }
      return { cleared: false, reason: 'Focused element is not editable' };
    })()`;
    const clearResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: clearScript, returnByValue: true,
    })) as { result: { value: { cleared: boolean; reason?: string; tag?: string } } };

    if (!clearResult.result.value.cleared) {
      return { before: before.result.value, editTriggered: false, reason: clearResult.result.value.reason };
    }

    if (useEnterToSubmit) {
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      });
    } else {
      // Blur to trigger save
      await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: `document.activeElement && document.activeElement.blur()`,
      });
    }
    await new Promise((r) => setTimeout(r, 400));

    // Check if element still exists and what its text is
    const afterScript = `(() => {
      const el = document.querySelector(${JSON.stringify(elementSelector)});
      return {
        exists: !!el,
        text: el ? (el.textContent || el.value || '').trim() : null,
        emptyTextSaved: el ? (el.textContent || el.value || '').trim() === '' : false,
      };
    })()`;
    const after = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: afterScript, returnByValue: true,
    })) as { result: { value: { exists: boolean; text: string | null; emptyTextSaved: boolean } } };

    return {
      before: before.result.value,
      editTriggered: true,
      after: after.result.value,
      shouldDeleteWhenEmpty: true, // expectation
      bugDetected: after.result.value.exists && after.result.value.emptyTextSaved,
      note: after.result.value.exists && after.result.value.emptyTextSaved
        ? 'BUG: Empty edit was saved instead of deleting the item'
        : after.result.value.exists
          ? 'Item still exists with non-empty text (may have been reverted)'
          : 'Item was removed after empty edit (correct behavior)',
    };
  });

  // Removed: test_add_in_filtered_view was too app-specific (SPA filter-tab switching).
}

