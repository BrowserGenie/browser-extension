import { registerHandler } from '../command-router.js';
import { debuggerManager } from '../debugger-manager.js';

export function registerAuditHandlers(): void {
  registerHandler('run_accessibility_audit', async (params, tabId) => {
    const { selector, tags } = params as { selector?: string; tags?: string[] };
    await debuggerManager.ensureAttached(tabId);

    // Inject axe-core content script into MAIN world so Runtime.evaluate can access it
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/axe.js'],
        world: 'MAIN',
      });
    } catch (err: any) {
      return { error: 'Failed to inject axe-core content script: ' + err.message, passed: false };
    }

    // Verify axe loaded successfully
    const verifyScript = `(() => { return typeof axe !== 'undefined' && axe && typeof axe.run === 'function'; })()`;
    const verifyResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: verifyScript,
      returnByValue: true,
    })) as { result: { value: boolean }; exceptionDetails?: any };

    if (verifyResult.exceptionDetails || !verifyResult.result?.value) {
      return {
        error: 'axe-core failed to load. The content script may have been blocked by CSP, the page may be incompatible, or the script injection failed.',
        passed: false,
        diagnosis: 'Try running the audit on a simpler page, or check if the page has a strict Content-Security-Policy.',
      };
    }

    // Build options and context carefully to avoid serialization issues
    const optionsObj = tags && tags.length > 0 ? { runOnly: { type: 'tag', values: tags } } : {};
    const contextObj = selector ? { include: [selector] } : null;

    const script = `(() => {
      const options = ${JSON.stringify(optionsObj)};
      const context = ${JSON.stringify(contextObj)};
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          resolve({ error: 'axe.run timed out after 10 seconds. The page may have CSP blocking axe-core execution.', passed: false });
        }, 10000);
        try {
          axe.run(context, options)
            .then((results) => {
              clearTimeout(timeout);
              resolve({
                violations: results.violations.map(v => ({
                  id: v.id,
                  impact: v.impact,
                  description: v.description,
                  helpUrl: v.helpUrl,
                  nodes: v.nodes.map(n => ({
                    selector: n.target.join(' '),
                    html: n.html,
                    target: n.target,
                  })),
                })),
                incomplete: results.incomplete.map(i => ({
                  id: i.id,
                  impact: i.impact,
                  description: i.description,
                  helpUrl: i.helpUrl,
                  nodes: i.nodes.map(n => ({
                    selector: n.target.join(' '),
                    html: n.html,
                    target: n.target,
                  })),
                })),
                passes: results.passes.length,
                summary: {
                  violationCount: results.violations.length,
                  incompleteCount: results.incomplete.length,
                  passCount: results.passes.length,
                },
                passed: results.violations.length === 0,
              });
            })
            .catch((err) => {
              clearTimeout(timeout);
              resolve({ error: err && err.message ? err.message : String(err), passed: false });
            });
        } catch (err) {
          clearTimeout(timeout);
          resolve({ error: err && err.message ? err.message : String(err), passed: false });
        }
      });
    })()`;

    const evalResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: unknown }; exceptionDetails?: any };

    if (evalResult.exceptionDetails) {
      const exc = evalResult.exceptionDetails as any;
      return {
        error: exc.exception?.description || exc.text || 'axe-core execution threw an exception',
        passed: false,
        diagnosis: 'The page may have JavaScript that conflicts with axe-core, or a strict CSP.',
      };
    }

    const value = evalResult.result?.value as Record<string, any> | undefined;
    if (!value) {
      return {
        error: 'axe-core returned an empty result. This may indicate a CSP blocking the audit or an incompatible page.',
        passed: false,
        diagnosis: 'Try running on a different page, or check the browser console for CSP errors.',
      };
    }
    if (value.error) {
      return { error: value.error, passed: false, diagnosis: value.diagnosis || 'axe-core audit failed to execute' };
    }
    return value;
  });

  registerHandler('check_color_contrast', async (params, tabId) => {
    const { selector } = params as { selector?: string };
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      function luminance(r, g, b) {
        const a = [r, g, b].map(function (v) {
          v /= 255;
          return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
        });
        return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
      }
      function parseColor(colorStr) {
        const div = document.createElement('div');
        div.style.color = colorStr;
        document.body.appendChild(div);
        const rgb = getComputedStyle(div).color;
        document.body.removeChild(div);
        const m = rgb.match(/rgb\\((\\d+),\\s*(\\d+),\\s*(\\d+)\\)/);
        if (!m) return null;
        return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
      }
      const elements = ${JSON.stringify(selector)}
        ? Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        : Array.from(document.querySelectorAll('p, span, a, h1, h2, h3, h4, h5, h6, li, td, th, label, button, input, textarea, select'));
      const results = [];
      for (const el of elements) {
        const s = getComputedStyle(el);
        const fg = parseColor(s.color);
        const bg = parseColor(s.backgroundColor);
        if (!fg || !bg) continue;
        const l1 = luminance(fg.r, fg.g, fg.b);
        const l2 = luminance(bg.r, bg.g, bg.b);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
        const fontSize = parseFloat(s.fontSize);
        const isLarge = fontSize >= 18 || (fontSize >= 14 && parseInt(s.fontWeight) >= 700);
        results.push({
          selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
          fontSize: s.fontSize,
          fontWeight: s.fontWeight,
          foreground: s.color,
          background: s.backgroundColor,
          ratio: Math.round(ratio * 100) / 100,
          aa: isLarge ? ratio >= 3 : ratio >= 4.5,
          aaa: isLarge ? ratio >= 4.5 : ratio >= 7,
        });
      }
      return results;
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_tab_order', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
        function getUniqueSelector(el) {
          if (el.id) return '#' + el.id;
          const tag = el.tagName.toLowerCase();
          const classes = Array.from(el.classList).slice(0, 3).join('.');
          let sel = classes ? tag + '.' + classes : tag;
          if (el.name) sel += '[name="' + el.name + '"]';
          if (el.type && el.type !== 'text') sel += '[type="' + el.type + '"]';
          if (el.placeholder) sel += '[placeholder="' + el.placeholder + '"]';
          if (tag === 'a' && el.getAttribute('href')) sel += '[href="' + el.getAttribute('href') + '"]';
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length > 1) {
              const index = siblings.indexOf(el) + 1;
              sel += ':nth-of-type(' + index + ')';
            }
          }
          return sel;
        }
      function isActuallyVisible(el) {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
        let parent = el.parentElement;
        while (parent) {
          const ps = getComputedStyle(parent);
          if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) === 0) return false;
          parent = parent.parentElement;
        }
        return true;
      }
      const focusable = Array.from(document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"]), [contenteditable]'));
      focusable.sort((a, b) => {
        const ta = parseInt(a.getAttribute('tabindex') || '0', 10);
        const tb = parseInt(b.getAttribute('tabindex') || '0', 10);
        if (ta !== tb) return ta - tb;
        return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      });
      const positiveTabIndex = focusable.filter(el => parseInt(el.getAttribute('tabindex') || '0', 10) > 0);
      return {
        elements: focusable.map(el => ({
          selector: getUniqueSelector(el),
          tagName: el.tagName,
          text: el.textContent.trim().substring(0, 100),
          tabIndex: parseInt(el.getAttribute('tabindex') || '0', 10),
          role: el.getAttribute('role') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          visible: isActuallyVisible(el),
        })),
        positiveTabIndex: positiveTabIndex.map(el => ({
          selector: getUniqueSelector(el),
          tagName: el.tagName,
          tabIndex: parseInt(el.getAttribute('tabindex') || '0', 10),
        })),
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('get_performance_metrics', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paint = performance.getEntriesByType('paint');
      const lcp = performance.getEntriesByType('largest-contentful-paint');
      const cls = performance.getEntriesByType('layout-shift');
      const fid = performance.getEntriesByType('first-input');
      const memory = performance.memory || {};
      return {
        navigation: {
          domContentLoaded: nav.domContentLoadedEventEnd,
          load: nav.loadEventEnd,
          responseEnd: nav.responseEnd,
          requestStart: nav.requestStart,
          fetchStart: nav.fetchStart,
        },
        paint: paint.map(p => ({ name: p.name, startTime: p.startTime })),
        lcp: lcp.length > 0 ? { startTime: lcp[lcp.length - 1].startTime } : null,
        cls: cls.length > 0 ? { value: cls.reduce((sum, e) => sum + (e.value || 0), 0) } : null,
        fid: fid.length > 0 ? { delay: fid[0].processingStart - fid[0].startTime } : null,
        memory: {
          usedJSHeapSize: memory.usedJSHeapSize,
          totalJSHeapSize: memory.totalJSHeapSize,
          jsHeapSizeLimit: memory.jsHeapSizeLimit,
        },
      };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('check_font_loading', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const fonts = [];
      if (document.fonts) {
        document.fonts.forEach(font => {
          fonts.push({
            family: font.family,
            status: font.status,
            weight: font.weight,
            style: font.style,
          });
        });
      }
      const allLoaded = fonts.every(f => f.status === 'loaded');
      return { allLoaded, fonts };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('audit_broken_resources', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const issues = [];
      // Broken images
      for (const img of document.querySelectorAll('img')) {
        if (img.naturalWidth === 0 && img.naturalHeight === 0 && !img.complete) {
          issues.push({ type: 'image', url: img.src, issue: 'Failed to load' });
        }
      }
      // Stylesheet errors
      for (const link of document.querySelectorAll('link[rel="stylesheet"]')) {
        try {
          if (link.sheet && link.sheet.cssRules === null) {
            issues.push({ type: 'stylesheet', url: link.href, issue: 'CSS rules inaccessible (possible CORS error)' });
          }
        } catch (e) {
          issues.push({ type: 'stylesheet', url: link.href, issue: 'CORS error accessing stylesheet' });
        }
      }
      // Font errors
      if (document.fonts) {
        document.fonts.forEach(font => {
          if (font.status === 'error') {
            issues.push({ type: 'font', url: font.family, issue: 'Font failed to load' });
          }
        });
      }
      return issues;
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('check_security_headers', async (params, tabId) => {
    const { url } = params as { url?: string };
    await debuggerManager.ensureAttached(tabId);

    const tab = await chrome.tabs.get(tabId);
    const targetUrl = url || tab.url || '';

    // We need network logs to inspect headers. Try to get the main document request.
    // Since network logs may not have the initial navigation, we do a fresh fetch via CDP.
    const result = (await debuggerManager.sendCommand(tabId, 'Network.enable')) as unknown;
    await new Promise(r => setTimeout(r, 100));

    // Use Runtime.evaluate to fetch headers via XMLHttpRequest for the current page
    const script = `(() => {
      return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('HEAD', window.location.href, true);
        xhr.onreadystatechange = function() {
          if (xhr.readyState === 4) {
            const headers = {};
            const headerNames = ['content-security-policy', 'strict-transport-security', 'x-frame-options', 'x-content-type-options', 'referrer-policy', 'permissions-policy', 'x-xss-protection'];
            for (const name of headerNames) {
              headers[name] = xhr.getResponseHeader(name);
            }
            resolve(headers);
          }
        };
        xhr.onerror = () => resolve({});
        xhr.send();
      });
    })()`;

    const evalResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    })) as { result: { value: Record<string, string | null> } };

    const headers = evalResult.result.value || {};
    const checks = [
      { header: 'content-security-policy', present: !!headers['content-security-policy'], value: headers['content-security-policy'] || '', recommendation: 'Should be present', status: headers['content-security-policy'] ? 'good' : 'missing' },
      { header: 'strict-transport-security', present: !!headers['strict-transport-security'], value: headers['strict-transport-security'] || '', recommendation: 'max-age should be >= 31536000', status: headers['strict-transport-security'] ? 'good' : 'missing' },
      { header: 'x-frame-options', present: !!headers['x-frame-options'], value: headers['x-frame-options'] || '', recommendation: 'Should be DENY or SAMEORIGIN', status: (headers['x-frame-options']?.toUpperCase() === 'DENY' || headers['x-frame-options']?.toUpperCase() === 'SAMEORIGIN') ? 'good' : (headers['x-frame-options'] ? 'warning' : 'missing') },
      { header: 'x-content-type-options', present: headers['x-content-type-options'] === 'nosniff', value: headers['x-content-type-options'] || '', recommendation: 'Should be nosniff', status: headers['x-content-type-options'] === 'nosniff' ? 'good' : 'missing' },
      { header: 'referrer-policy', present: !!headers['referrer-policy'], value: headers['referrer-policy'] || '', recommendation: 'Should be present', status: headers['referrer-policy'] ? 'good' : 'missing' },
      { header: 'permissions-policy', present: !!headers['permissions-policy'], value: headers['permissions-policy'] || '', recommendation: 'Should be present', status: headers['permissions-policy'] ? 'good' : 'missing' },
      { header: 'x-xss-protection', present: !!headers['x-xss-protection'], value: headers['x-xss-protection'] || '', recommendation: 'Deprecated, modern browsers use CSP instead', status: headers['x-xss-protection'] ? 'warning' : 'missing' },
    ];

    return checks;
  });

  registerHandler('detect_cookie_banners', async (_params, tabId) => {
    await debuggerManager.ensureAttached(tabId);

    const script = `(() => {
      const patterns = [
        '#cookie-banner', '#cookie-notice', '.cookie-banner', '.cookie-notice',
        '.consent-banner', '#consent-banner', '[class*="cookie-banner"]', '[class*="consent"]',
        '[id*="cookie"]', '[id*="consent"]',
        '#onetrust-banner-sdk', '#CybotCookiebotDialog', '.qc-cmp2-container',
        '#cmpbox', '#cmp-banner', '.cc-banner', '.cc-window',
      ];
      const banners = [];
      for (const pattern of patterns) {
        try {
          const els = Array.from(document.querySelectorAll(pattern));
          for (const el of els) {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') {
              const buttons = Array.from(el.querySelectorAll('button, a[role="button"], input[type="button"], input[type="submit"]'));
              banners.push({
                selector: pattern,
                text: el.textContent.trim().substring(0, 200),
                acceptButton: buttons[0]?.textContent?.trim().substring(0, 50) || null,
                rejectButton: buttons[1]?.textContent?.trim().substring(0, 50) || null,
                customizeButton: buttons[2]?.textContent?.trim().substring(0, 50) || null,
              });
            }
          }
        } catch (e) {}
      }
      // Also check aria-label
      const ariaEls = Array.from(document.querySelectorAll('[aria-label*="cookie" i], [aria-label*="consent" i]'));
      for (const el of ariaEls) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          banners.push({
            selector: el.tagName.toLowerCase() + '[aria-label]',
            text: el.textContent.trim().substring(0, 200),
            acceptButton: null,
            rejectButton: null,
            customizeButton: null,
          });
        }
      }
      return { detected: banners.length > 0, banners: banners.slice(0, 10) };
    })()`;

    const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
      expression: script,
      returnByValue: true,
    })) as { result: { value: unknown } };

    return result.result.value;
  });

  registerHandler('record_performance_timeline', async (params, tabId) => {
    const { action, interval = 1000, duration = 10000 } = params as {
      action: 'start' | 'stop' | 'get';
      interval?: number;
      duration?: number;
    };
    await debuggerManager.ensureAttached(tabId);

    if (action === 'start') {
      const script = `(() => {
        if (window.__browserGeniePerfTimeline) {
          clearInterval(window.__browserGeniePerfTimeline.intervalId);
        }
        window.__browserGeniePerfTimeline = {
          entries: [],
          intervalId: null,
          startTime: performance.now(),
        };
        const collect = () => {
          const memory = performance.memory || {};
          const paint = performance.getEntriesByType('paint');
          const lcp = performance.getEntriesByType('largest-contentful-paint');
          const cls = performance.getEntriesByType('layout-shift');
          window.__browserGeniePerfTimeline.entries.push({
            timestamp: performance.now(),
            usedJSHeapSize: memory.usedJSHeapSize,
            totalJSHeapSize: memory.totalJSHeapSize,
            fps: null, // Would need requestAnimationFrame loop for FPS
            lcp: lcp.length > 0 ? lcp[lcp.length - 1].startTime : null,
            cls: cls.reduce((sum, e) => sum + (e.value || 0), 0),
          });
        };
        collect();
        window.__browserGeniePerfTimeline.intervalId = setInterval(collect, ${interval});
        return { started: true };
      })()`;

      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: unknown } };

      return result.result.value;
    }

    if (action === 'get') {
      const script = `(() => {
        const timeline = window.__browserGeniePerfTimeline;
        if (!timeline) return { error: 'Timeline not started' };
        const entries = timeline.entries;
        const usedHeap = entries.map(e => e.usedJSHeapSize).filter(v => v != null);
        const clsValues = entries.map(e => e.cls).filter(v => v != null);
        return {
          entryCount: entries.length,
          duration: entries.length > 0 ? entries[entries.length - 1].timestamp - entries[0].timestamp : 0,
          memory: {
            start: usedHeap[0] || null,
            end: usedHeap[usedHeap.length - 1] || null,
            growth: usedHeap.length > 1 ? usedHeap[usedHeap.length - 1] - usedHeap[0] : null,
          },
          cls: {
            start: clsValues[0] || 0,
            end: clsValues[clsValues.length - 1] || 0,
            max: Math.max(...clsValues, 0),
          },
          entries: entries.slice(-200),
        };
      })()`;

      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: unknown } };

      return result.result.value;
    }

    if (action === 'stop') {
      const script = `(() => {
        if (window.__browserGeniePerfTimeline) {
          clearInterval(window.__browserGeniePerfTimeline.intervalId);
          const entries = window.__browserGeniePerfTimeline.entries;
          const usedHeap = entries.map(e => e.usedJSHeapSize).filter(v => v != null);
          const clsValues = entries.map(e => e.cls).filter(v => v != null);
          const result = {
            entryCount: entries.length,
            duration: entries.length > 0 ? entries[entries.length - 1].timestamp - entries[0].timestamp : 0,
            memory: {
              start: usedHeap[0] || null,
              end: usedHeap[usedHeap.length - 1] || null,
              growth: usedHeap.length > 1 ? usedHeap[usedHeap.length - 1] - usedHeap[0] : null,
            },
            cls: {
              start: clsValues[0] || 0,
              end: clsValues[clsValues.length - 1] || 0,
              max: Math.max(...clsValues, 0),
            },
            entries: entries.slice(-200),
          };
          delete window.__browserGeniePerfTimeline;
          return result;
        }
        return { error: 'Timeline not started' };
      })()`;

      const result = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: script,
        returnByValue: true,
      })) as { result: { value: unknown } };

      return result.result.value;
    }

    return { error: 'Unknown action' };
  });

  registerHandler('record_focus_path', async (params, tabId) => {
    const { steps = 10 } = params as { steps?: number };
    await debuggerManager.ensureAttached(tabId);

    const path = [];
    for (let i = 0; i < steps; i++) {
      const beforeScript = `(() => {
        function isActuallyVisible(el) {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) return false;
          const s = getComputedStyle(el);
          if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) return false;
          // Check if hidden by parent
          let parent = el.parentElement;
          while (parent) {
            const ps = getComputedStyle(parent);
            if (ps.display === 'none' || ps.visibility === 'hidden' || parseFloat(ps.opacity) === 0) return false;
            parent = parent.parentElement;
          }
          return true;
        }
        function getUniqueSelector(el) {
          if (el.id) return '#' + el.id;
          const tag = el.tagName.toLowerCase();
          const classes = Array.from(el.classList).slice(0, 3).join('.');
          let sel = classes ? tag + '.' + classes : tag;
          if (el.name) sel += '[name="' + el.name + '"]';
          if (el.type) sel += '[type="' + el.type + '"]';
          if (tag === 'a' && el.getAttribute('href')) sel += '[href="' + el.getAttribute('href') + '"]';
          const parent = el.parentElement;
          if (parent) {
            const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
            if (siblings.length > 1) {
              const index = siblings.indexOf(el) + 1;
              sel += ':nth-of-type(' + index + ')';
            }
          }
          return sel;
        }
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return {
          selector: getUniqueSelector(el),
          tagName: el.tagName,
          text: el.textContent?.trim().substring(0, 100),
          tabIndex: parseInt(el.getAttribute('tabindex') || '0', 10),
          visible: isActuallyVisible(el),
          opacity: parseFloat(getComputedStyle(el).opacity),
        };
      })()`;

      const beforeResult = (await debuggerManager.sendCommand(tabId, 'Runtime.evaluate', {
        expression: beforeScript,
        returnByValue: true,
      })) as { result: { value: any } };

      const focusInfo = beforeResult.result.value;
      path.push({
        step: i + 1,
        ...focusInfo,
        invisibleFocus: focusInfo ? !focusInfo.visible : false,
      });

      // Press Tab
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'Tab',
        code: 'Tab',
        keyIdentifier: 'U+0009',
      });
      await debuggerManager.sendCommand(tabId, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Tab',
        code: 'Tab',
        keyIdentifier: 'U+0009',
      });

      await new Promise((r) => setTimeout(r, 100));
    }

    return { steps, path };
  });
}
