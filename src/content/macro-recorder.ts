// Content script for recording user interactions
interface RecordedEvent {
  type: string;
  timestamp: number;
  selector?: string;
  x?: number;
  y?: number;
  key?: string;
  text?: string;
  value?: string;
}

let isRecording = false;
const recordedEvents: RecordedEvent[] = [];

function getSelector(el: Element): string {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const classes = Array.from(el.classList).slice(0, 2).join('.');
  let selector = classes ? `${tag}.${classes}` : tag;
  const parent = el.parentElement;
  if (parent && parent.tagName.toLowerCase() !== 'html' && parent.tagName.toLowerCase() !== 'body') {
    const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
    if (siblings.length > 1) {
      const index = siblings.indexOf(el) + 1;
      selector += `:nth-of-type(${index})`;
    }
    selector = getSelector(parent) + ' > ' + selector;
  }
  return selector;
}

function recordEvent(event: RecordedEvent) {
  if (!isRecording) return;
  recordedEvents.push(event);
}

document.addEventListener('click', (e) => {
  if (!isRecording) return;
  const target = e.target as Element;
  recordEvent({
    type: 'click',
    timestamp: Date.now(),
    selector: getSelector(target),
    x: e.clientX,
    y: e.clientY,
  });
}, true);

document.addEventListener('keydown', (e) => {
  if (!isRecording) return;
  recordEvent({
    type: 'keydown',
    timestamp: Date.now(),
    key: e.key,
  });
}, true);

document.addEventListener('input', (e) => {
  if (!isRecording) return;
  const target = e.target as HTMLInputElement;
  recordEvent({
    type: 'input',
    timestamp: Date.now(),
    selector: getSelector(target),
    text: target.value,
  });
}, true);

document.addEventListener('change', (e) => {
  if (!isRecording) return;
  const target = e.target as HTMLInputElement;
  recordEvent({
    type: 'change',
    timestamp: Date.now(),
    selector: getSelector(target),
    value: target.value,
  });
}, true);

// Expose API for the background script to control recording
(window as any).__browserGenieMacroRecorder = {
  start: () => {
    isRecording = true;
    recordedEvents.length = 0;
    return { started: true };
  },
  stop: () => {
    isRecording = false;
    return { events: [...recordedEvents] };
  },
  getEvents: () => [...recordedEvents],
};
