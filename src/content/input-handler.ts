// Content script for input field interaction

export function simulateInputAndType(
  selector: string,
  text: string,
  selectorType: 'css' | 'xpath' = 'css',
  clearFirst = true
): { success: boolean; error?: string } {
  let element: HTMLElement | null = null;

  if (selectorType === 'css') {
    element = document.querySelector(selector) as HTMLElement;
  } else {
    const result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    element = result.singleNodeValue as HTMLElement;
  }

  if (!element) {
    return { success: false, error: `Element not found: ${selector}` };
  }

  element.focus();
  element.click();

  if (clearFirst && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
    element.value = '';
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }

  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.value = text;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  return { success: true };
}
