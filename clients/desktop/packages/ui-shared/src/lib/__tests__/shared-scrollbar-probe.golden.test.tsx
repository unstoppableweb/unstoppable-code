/** @jest-environment jsdom */
import { act, useRef, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SCROLLBAR_PROBE_ATTRIBUTE } from '../scrollbar-mode-script';
import {
  useScrollbarBehavior,
  type ResolvedScrollbarBehavior,
} from '../useAlwaysVisibleScrollbars';

/*
 * CAN-7191: every scroll area resolves the native scrollbar behavior on mount
 * and on each window focus, and each probe forces a layout of the whole
 * document. Scroll areas in one document now share one probe per mount batch
 * and one per focus, and still see exactly the value a probe of their own
 * would return.
 */

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

const COUNT = 5;
let probes = 0;
let probeWidth = 0;
const seen = new Map<string, ResolvedScrollbarBehavior>();
const roots: Root[] = [];

function ScrollArea({ id }: { id: string }): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  seen.set(id, useScrollbarBehavior(ref));
  return <div ref={ref} />;
}

function mount(container: Element, prefix: string): void {
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <>
        {Array.from({ length: COUNT }, (_, index) => (
          <ScrollArea key={index} id={`${prefix}-${index}`} />
        ))}
      </>,
    );
  });
}

function behaviors(prefix: string): ResolvedScrollbarBehavior[] {
  return Array.from(seen)
    .filter(([id]) => id.startsWith(`${prefix}-`))
    .map(([, behavior]) => behavior);
}

function focus(view: Window): void {
  act(() => {
    view.dispatchEvent(new FocusEvent('focus'));
  });
}

/** Ends the task that measured, as the browser would. */
function endTask(): void {
  act(() => {
    jest.runOnlyPendingTimers();
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  probes = 0;
  probeWidth = 0;
  seen.clear();
  delete document.documentElement.dataset.scrollbarBehavior;
  jest
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockImplementation(function (this: HTMLElement): number {
      if (!this.hasAttribute(SCROLLBAR_PROBE_ATTRIBUTE)) return 0;
      probes += 1;
      return probeWidth;
    });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  endTask();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

describe('scroll areas share one scrollbar probe per document (CAN-7191)', () => {
  it('probes once for scroll areas mounting together', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mount(container, 'main');
    expect(probes).toBe(1);
    expect(behaviors('main')).toEqual(Array(COUNT).fill('scroll'));
  });

  it('probes once per window focus, whatever the scroll area count', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mount(container, 'main');
    endTask();
    focus(window);
    expect(probes).toBe(2);
    endTask();
    focus(window);
    expect(probes).toBe(3);
  });

  it('gives every scroll area the new width after the entry clears', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mount(container, 'main');
    endTask();
    probeWidth = 15;
    focus(window);
    expect(behaviors('main')).toEqual(Array(COUNT).fill('always'));
    expect(
      document.documentElement.style.getPropertyValue(
        '--canopy-native-scrollbar-width',
      ),
    ).toBe('15px');
  });

  it('re-probes on focus even when the end-of-task clear has not run', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    mount(container, 'main');
    expect(behaviors('main')).toEqual(Array(COUNT).fill('scroll'));
    // A hidden window's timers can be held back: the clear stays pending.
    probeWidth = 15;
    focus(window);
    expect(probes).toBe(2);
    expect(behaviors('main')).toEqual(Array(COUNT).fill('always'));
  });

  it('keeps a separate entry for each document', () => {
    const frame = document.createElement('iframe');
    document.body.appendChild(frame);
    const frameDocument = frame.contentDocument;
    const frameView = frame.contentWindow;
    if (frameDocument === null || frameView === null)
      throw new Error('jsdom gave the frame no document');
    const container = document.createElement('div');
    document.body.appendChild(container);
    const frameContainer = frameDocument.createElement('div');
    frameDocument.body.appendChild(frameContainer);
    mount(container, 'main');
    mount(frameContainer, 'frame');
    expect(probes).toBe(2);
    endTask();
    focus(frameView);
    expect(probes).toBe(3);
  });

  it('never probes for an explicit preference, and re-resolves when it changes', async () => {
    document.documentElement.dataset.scrollbarBehavior = 'hover';
    const container = document.createElement('div');
    document.body.appendChild(container);
    mount(container, 'main');
    focus(window);
    expect(probes).toBe(0);
    expect(behaviors('main')).toEqual(Array(COUNT).fill('hover'));
    await act(async () => {
      delete document.documentElement.dataset.scrollbarBehavior;
      await Promise.resolve();
    });
    expect(probes).toBe(1);
    expect(behaviors('main')).toEqual(Array(COUNT).fill('scroll'));
  });
});
