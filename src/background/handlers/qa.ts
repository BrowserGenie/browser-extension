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
}
