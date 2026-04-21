// Content script for hover simulation

export function simulateHover(
  selector: string,
  selectorType: 'css' | 'xpath' = 'css'
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
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
  };

  element.dispatchEvent(new MouseEvent('mouseenter', eventInit));
  element.dispatchEvent(new MouseEvent('mouseover', eventInit));
  element.dispatchEvent(new MouseEvent('mousemove', eventInit));

  return { success: true };
}
