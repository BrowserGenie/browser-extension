// Content script for drag and drop simulation using HTML5 Drag API

export function simulateDragDrop(
  fromSelector: string,
  toSelector: string,
  selectorType: 'css' | 'xpath' = 'css'
): { success: boolean; error?: string } {
  function findElement(sel: string): Element | null {
    if (selectorType === 'css') return document.querySelector(sel);
    const result = document.evaluate(sel, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
    return result.singleNodeValue as Element;
  }

  const source = findElement(fromSelector);
  const target = findElement(toSelector);

  if (!source) return { success: false, error: `Source not found: ${fromSelector}` };
  if (!target) return { success: false, error: `Target not found: ${toSelector}` };

  const dataTransfer = new DataTransfer();

  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer, clientX: sourceRect.x, clientY: sourceRect.y }));
  source.dispatchEvent(new DragEvent('drag', { bubbles: true, dataTransfer }));
  target.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer, clientX: targetRect.x, clientY: targetRect.y }));
  target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer, clientX: targetRect.x, clientY: targetRect.y }));
  target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer, clientX: targetRect.x, clientY: targetRect.y }));
  source.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }));

  return { success: true };
}
