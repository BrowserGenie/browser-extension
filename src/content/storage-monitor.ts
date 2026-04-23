(function() {
  if ((window as any).__browserGenieStorageMonitor) return;

  const events: Array<{ type: string; key?: string; oldValue?: string | null; newValue?: string | null; timestamp: number; source: string }> = [];

  function record(type: string, key: string | null, oldValue: string | null, newValue: string | null, source: string) {
    events.push({ type, key: key || undefined, oldValue, newValue, timestamp: Date.now(), source });
  }

  // Cross-tab events
  window.addEventListener('storage', (e: StorageEvent) => {
    record(e.key || 'unknown', e.key, e.oldValue, e.newValue, 'cross-tab');
  });

  // Same-tab localStorage overrides
  const origLocalSet = localStorage.setItem.bind(localStorage);
  const origLocalRemove = localStorage.removeItem.bind(localStorage);
  const origLocalClear = localStorage.clear.bind(localStorage);

  localStorage.setItem = function(key: string, value: string) {
    const oldValue = localStorage.getItem(key);
    origLocalSet(key, value);
    record('set', key, oldValue, value, 'same-tab');
  };
  localStorage.removeItem = function(key: string) {
    const oldValue = localStorage.getItem(key);
    origLocalRemove(key);
    record('remove', key, oldValue, null, 'same-tab');
  };
  localStorage.clear = function() {
    origLocalClear();
    record('clear', null, null, null, 'same-tab');
  };

  // Same-tab sessionStorage overrides
  const origSessionSet = sessionStorage.setItem.bind(sessionStorage);
  const origSessionRemove = sessionStorage.removeItem.bind(sessionStorage);
  const origSessionClear = sessionStorage.clear.bind(sessionStorage);

  sessionStorage.setItem = function(key: string, value: string) {
    const oldValue = sessionStorage.getItem(key);
    origSessionSet(key, value);
    record('set', key, oldValue, value, 'same-tab');
  };
  sessionStorage.removeItem = function(key: string) {
    const oldValue = sessionStorage.getItem(key);
    origSessionRemove(key);
    record('remove', key, oldValue, null, 'same-tab');
  };
  sessionStorage.clear = function() {
    origSessionClear();
    record('clear', null, null, null, 'same-tab');
  };

  (window as any).__browserGenieStorageMonitor = { events, record };
})();
