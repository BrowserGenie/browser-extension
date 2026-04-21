// Content script for click simulation
// Injected dynamically when needed for "real" DOM event clicks

export function simulateClick(
  selector: string,
  selectorType: 'css' | 'xpath' = 'css',
  button: 'left' | 'right' | 'middle' = 'left',
  doubleClick = false
): { success: boolean; error?: string } {
  let element: Element | null = null;

  if (selectorType === 'css') {
    element = document.querySelector(selector);
  } else {
    const result = document.evaluate(selector, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    element = result.singleNodeValue as Element;
  }

  if (!element) {
    return { success: false, error: `Element not found: ${selector}` };
  }

  const rect = element.getBoundingClientRect();
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  const buttonNum = button === 'left' ? 0 : button === 'middle' ? 1 : 2;

  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    button: buttonNum,
  };

  element.dispatchEvent(new MouseEvent('mouseover', eventInit));
  element.dispatchEvent(new MouseEvent('mousedown', eventInit));
  element.dispatchEvent(new MouseEvent('mouseup', eventInit));
  element.dispatchEvent(new MouseEvent('click', eventInit));

  if (doubleClick) {
    element.dispatchEvent(new MouseEvent('mousedown', { ...eventInit, detail: 2 }));
    element.dispatchEvent(new MouseEvent('mouseup', { ...eventInit, detail: 2 }));
    element.dispatchEvent(new MouseEvent('dblclick', { ...eventInit, detail: 2 }));
  }

  return { success: true };
}
