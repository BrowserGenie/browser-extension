import axe from 'axe-core';

// Expose axe globally so the audit handler can use it via Runtime.evaluate
(window as any).axe = axe;
