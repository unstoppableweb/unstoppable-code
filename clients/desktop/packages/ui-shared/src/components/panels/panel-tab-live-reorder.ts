/**
 * Live reordering of fill tabs (early access).
 *
 * A dragged tab stays in its row and follows the pointer along it; the tabs
 * it passes slide aside to open its slot, and on release every tab settles
 * into its final place. A drag that leaves the title row turns into a plain
 * move to another group: the row closes up again and a small chip follows the
 * pointer instead.
 *
 * The drag itself is still a native HTML drag (the panel system's drop
 * targets are native), so this module only draws: it writes transforms on the
 * tab elements and never reorders the DOM. The tab bar commits the reorder on
 * drop and then calls {@link LiveTabReorder.finish}, which animates each tab
 * from where it was drawn to where the new layout puts it.
 */

import { REPLAY_MASK_CLASS } from '../../lib/replay-privacy';

/** One tab's place in its strip before the drag: viewport left and width. */
export interface TabSlot {
  readonly left: number;
  readonly width: number;
}

export interface LiveTabReorderLayout {
  /** The dragged tab's index among the OTHER tabs of its strip. */
  readonly targetIndex: number;
  /** The dragged tab's viewport left, held inside the strip. */
  readonly draggedLeft: number;
  /** Horizontal offset per slot, in slot order; 0 for the dragged tab. */
  readonly shifts: readonly number[];
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Where everything sits while the dragged tab's left edge is at
 * `desiredLeft`. The dragged tab takes whichever place it is nearest to: it
 * swaps with a neighbour halfway between its place before that neighbour and
 * its place after it. The places come from the row as it was when the drag
 * began, never from the tabs as drawn, so the sliding cannot feed back.
 */
export function computeLiveTabReorder(
  slots: readonly TabSlot[],
  fromIndex: number,
  desiredLeft: number,
): LiveTabReorderLayout {
  const dragged = slots[fromIndex];
  const first = slots[0];
  const last = slots[slots.length - 1];
  if (dragged === undefined || first === undefined || last === undefined) {
    return {
      targetIndex: fromIndex,
      draggedLeft: desiredLeft,
      shifts: slots.map(() => 0),
    };
  }
  const second = slots[1];
  const gap =
    second === undefined
      ? 0
      : Math.max(0, second.left - (first.left + first.width));
  // How far a neighbour moves when the dragged tab passes it.
  const pitch = dragged.width + gap;
  const min = first.left;
  const max = Math.max(min, last.left + last.width - dragged.width);
  const draggedLeft = clamp(desiredLeft, min, max);

  // The other tabs, closed up as if the dragged one were lifted out.
  const others = slots
    .map((slot, index) => ({
      index,
      width: slot.width,
      origin: slot.left,
      packedLeft: index < fromIndex ? slot.left : slot.left - pitch,
    }))
    .filter((other) => other.index !== fromIndex);

  // Where the dragged tab rests at each place: at the row's start, or right
  // after the tab before it.
  let target = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let place = 0; place <= others.length; place += 1) {
    const before = others[place - 1];
    const restLeft =
      before === undefined ? min : before.packedLeft + before.width + gap;
    const distance = Math.abs(draggedLeft - restLeft);
    if (distance < nearest) {
      nearest = distance;
      target = place;
    }
  }

  const shifts = slots.map(() => 0);
  others.forEach((other, position) => {
    shifts[other.index] =
      other.packedLeft + (position >= target ? pitch : 0) - other.origin;
  });
  return { targetIndex: target, draggedLeft, shifts };
}

/** `strip`: reordering in its own row. `detached`: on its way elsewhere. */
export type LiveTabReorderMode = 'strip' | 'detached';

export interface LiveTabReorderOptions {
  /** The tab bar; its title row is the band the tab reorders within. */
  readonly bar: HTMLElement;
  readonly dragged: HTMLElement;
  /** Every tab of the dragged tab's strip, in order, the dragged one too. */
  readonly tabs: readonly HTMLElement[];
  /** Where the pointer took hold of the tab. */
  readonly grabClientX: number;
  /** Shown on the chip that follows the pointer outside the row. */
  readonly title: string;
  /** Replay-masks the chip, for a user-authored title. */
  readonly maskTitle?: boolean;
}

const SETTLE_DURATION_MS = 200;
/** Decelerates into place with no overshoot (DESIGN.md: no bounce). */
const SETTLE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
/** The chip sits just off the pointer's tip. */
const CHIP_OFFSET_PX = 12;

/** A 1px fully transparent GIF. */
const TRANSPARENT_PIXEL_SRC =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

let transparentDragImage: HTMLImageElement | null = null;

/**
 * A 1px transparent picture for `dataTransfer.setDragImage`: the tab itself
 * is the drag feedback, so the browser's own floating copy is not drawn.
 *
 * It has to be a decoded `<img>`. Given anything it cannot turn into a
 * picture (an element outside the document, or an image still loading) the
 * browser falls back to its default drag icon, a globe on macOS. So the tab
 * bar asks for this once when it mounts, well before the first drag.
 */
export function transparentTabDragImage(
  ownerDocument: Document,
): HTMLImageElement {
  if (
    transparentDragImage === null ||
    transparentDragImage.ownerDocument !== ownerDocument
  ) {
    transparentDragImage = ownerDocument.createElement('img');
    transparentDragImage.width = 1;
    transparentDragImage.height = 1;
    transparentDragImage.src = TRANSPARENT_PIXEL_SRC;
  }
  return transparentDragImage;
}

const HOVER_STALE_ATTRIBUTE = 'data-live-hover-stale';

/**
 * After a native drag the browser keeps resolving `:hover` at the spot where
 * the drag began, not where the pointer is, until the mouse really moves. A
 * reorder puts a different tab on that spot, which then lit up as hovered
 * while the pointer rested on another. So the tabs take no pointer hits
 * (panels.css) until the pointer truly moves again or presses: nothing is
 * hovered in between, the first real move restores hover where it is, and
 * a press without one still reaches the tab under it.
 */
function holdHoverUntilPointerMoves(bar: HTMLElement): void {
  const ownerDocument = bar.ownerDocument;
  bar.setAttribute(HOVER_STALE_ATTRIBUTE, '');
  const release = (): void => {
    bar.removeAttribute(HOVER_STALE_ATTRIBUTE);
    ownerDocument.removeEventListener('mousemove', onMouseMove, true);
    ownerDocument.removeEventListener('pointerdown', onPointerDown, true);
    ownerDocument.removeEventListener('dragstart', release, true);
  };
  // The browser's own hover refresh arrives as a move that went nowhere: no
  // movement, and always the same stale point. A real move reports movement,
  // or (from automation, which reports none) lands somewhere else.
  let stalePoint: { readonly x: number; readonly y: number } | null = null;
  const onMouseMove = (event: MouseEvent): void => {
    if (event.movementX !== 0 || event.movementY !== 0) {
      release();
    } else if (stalePoint === null) {
      stalePoint = { x: event.clientX, y: event.clientY };
    } else if (
      stalePoint.x !== event.clientX ||
      stalePoint.y !== event.clientY
    ) {
      release();
    }
  };
  // A press that arrives while the tabs take no hits was already aimed past
  // them, so its click goes to whatever lies behind and the tab would never
  // hear it. The press is handed to what the pointer is really on.
  const onPointerDown = (event: PointerEvent): void => {
    release();
    if (!('elementFromPoint' in ownerDocument)) {
      return;
    }
    const pressed = ownerDocument.elementFromPoint(
      event.clientX,
      event.clientY,
    );
    // An `Element`: a tab's icon is an SVG, which is not an `HTMLElement`.
    if (pressed === null || !bar.contains(pressed)) {
      return;
    }
    const forget = (): void => {
      ownerDocument.removeEventListener('click', onClick, true);
      ownerDocument.removeEventListener('pointerdown', forget, true);
    };
    const onClick = (click: MouseEvent): void => {
      forget();
      const target = click.target;
      if (
        target instanceof Node &&
        target !== pressed &&
        target.contains(pressed) &&
        ownerDocument.elementFromPoint(click.clientX, click.clientY) === pressed
      ) {
        pressed.dispatchEvent(
          new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: click.clientX,
            clientY: click.clientY,
          }),
        );
      }
    };
    ownerDocument.addEventListener('click', onClick, true);
    // Registered during this press, so only the next one runs it.
    ownerDocument.addEventListener('pointerdown', forget, true);
  };
  ownerDocument.addEventListener('mousemove', onMouseMove, true);
  ownerDocument.addEventListener('pointerdown', onPointerDown, true);
  ownerDocument.addEventListener('dragstart', release, true);
}

export class LiveTabReorder {
  mode: LiveTabReorderMode = 'strip';

  private readonly slots: readonly TabSlot[];
  private readonly fromIndex: number;
  private readonly grabOffset: number;
  private readonly bandTop: number;
  private readonly bandBottom: number;
  private readonly bandLeft: number;
  private readonly bandRight: number;
  private readonly view: Window | null;
  private readonly reducedMotion: boolean;
  private layout: LiveTabReorderLayout;
  private pointerX: number;
  private pointerY: number;
  private frame: number | null = null;
  private chip: HTMLElement | null = null;
  private held: readonly number[] | null = null;
  private finished = false;
  /** The scrolling strip and where it stood when the drag began. */
  private readonly scroller: HTMLElement | null;
  private readonly startScrollLeft: number;
  private readonly onScroll = (): void => {
    if (!this.finished) {
      this.pointerMoved(this.pointerX, this.pointerY);
    }
  };

  /** `null` when the row cannot be measured (not laid out yet). */
  static start(options: LiveTabReorderOptions): LiveTabReorder | null {
    const fromIndex = options.tabs.indexOf(options.dragged);
    // A tab still settling from the last drag is measured where it lands.
    for (const tab of options.tabs) {
      for (const animation of tab.getAnimations?.() ?? []) {
        animation.cancel();
      }
    }
    const band = (
      options.bar.closest<HTMLElement>('.canopy-panel-group-title') ??
      options.bar
    ).getBoundingClientRect();
    const slots = options.tabs.map((tab): TabSlot => {
      const rect = tab.getBoundingClientRect();
      return { left: rect.left, width: rect.width };
    });
    if (
      fromIndex === -1 ||
      band.height <= 0 ||
      slots.some((slot) => slot.width <= 0)
    ) {
      return null;
    }
    return new LiveTabReorder(options, slots, fromIndex, band);
  }

  private constructor(
    private readonly options: LiveTabReorderOptions,
    slots: readonly TabSlot[],
    fromIndex: number,
    band: DOMRect,
  ) {
    this.slots = slots;
    this.fromIndex = fromIndex;
    const slot = slots[fromIndex];
    this.grabOffset = options.grabClientX - (slot?.left ?? 0);
    this.bandTop = band.top;
    this.bandBottom = band.bottom;
    this.bandLeft = band.left;
    this.bandRight = band.right;
    this.view = options.bar.ownerDocument.defaultView;
    this.reducedMotion =
      this.view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ===
      true;
    this.pointerX = options.grabClientX;
    this.pointerY = (band.top + band.bottom) / 2;
    this.layout = computeLiveTabReorder(slots, fromIndex, slot?.left ?? 0);
    // The strip can scroll under the drag (wheel, trackpad): the places were
    // measured before that, so the pointer is read in their coordinates, and
    // a scroll alone re-lays the row.
    // The strip itself, not the tab's parent: a pinned tab sits in a
    // tooltip wrapper inside it.
    this.scroller = options.dragged.closest<HTMLElement>(
      '.canopy-panel-tab-strip',
    );
    this.startScrollLeft = this.scroller?.scrollLeft ?? 0;
    this.scroller?.addEventListener('scroll', this.onScroll, {
      passive: true,
    });
  }

  /** The dragged tab's index among the other tabs of its strip. */
  get targetIndex(): number {
    return this.layout.targetIndex;
  }

  /** Whether a drop now would change the order. */
  get moved(): boolean {
    return this.layout.targetIndex !== this.fromIndex;
  }

  /**
   * Follows the pointer. The mode and target are current as soon as this
   * returns (a drop reads them); the drawing waits for the next frame.
   */
  pointerMoved(clientX: number, clientY: number): LiveTabReorderMode {
    if (this.finished) {
      return this.mode;
    }
    this.pointerX = clientX;
    this.pointerY = clientY;
    // Past the row's left or right edge counts as outside too: a group
    // beside this one has its tab strip at the same height.
    this.mode =
      clientY >= this.bandTop &&
      clientY <= this.bandBottom &&
      clientX >= this.bandLeft &&
      clientX <= this.bandRight
        ? 'strip'
        : 'detached';
    if (this.mode === 'strip') {
      const scrolled = (this.scroller?.scrollLeft ?? 0) - this.startScrollLeft;
      this.layout = computeLiveTabReorder(
        this.slots,
        this.fromIndex,
        clientX + scrolled - this.grabOffset,
      );
    }
    this.scheduleDraw();
    return this.mode;
  }

  private scheduleDraw(): void {
    if (this.frame !== null) {
      return;
    }
    const request = this.view?.requestAnimationFrame?.bind(this.view);
    if (request === undefined) {
      this.draw();
      return;
    }
    // A frame that runs at once (a test's stand-in) must not leave a stale
    // handle behind, or no later move would ever draw.
    let ran = false;
    const frame = request((): void => {
      ran = true;
      this.frame = null;
      this.draw();
    });
    if (!ran) {
      this.frame = frame;
    }
  }

  private draw(): void {
    if (this.finished) {
      return;
    }
    const { dragged, tabs } = this.options;
    const slot = this.slots[this.fromIndex];
    const inStrip = this.mode === 'strip';
    tabs.forEach((tab, index) => {
      if (tab === dragged) {
        return;
      }
      // Outside the row the tabs close up again: nothing will land here.
      const shift = inStrip ? (this.layout.shifts[index] ?? 0) : 0;
      tab.setAttribute('data-live-shift', '');
      tab.style.transform = `translateX(${shift}px)`;
    });
    dragged.setAttribute('data-live-drag', this.mode);
    dragged.style.transform = `translateX(${
      inStrip ? this.layout.draggedLeft - (slot?.left ?? 0) : 0
    }px)`;
    this.drawChip(!inStrip);
  }

  private drawChip(visible: boolean): void {
    if (!visible) {
      this.chip?.remove();
      this.chip = null;
      return;
    }
    if (this.chip === null) {
      const ownerDocument = this.options.bar.ownerDocument;
      this.chip = ownerDocument.createElement('div');
      this.chip.className = 'canopy-panel-tab-drag-chip';
      if (this.options.maskTitle === true)
        this.chip.classList.add(REPLAY_MASK_CLASS);
      this.chip.setAttribute('aria-hidden', 'true');
      this.chip.textContent = this.options.title;
      ownerDocument.body.appendChild(this.chip);
    }
    this.chip.style.transform = `translate(${this.pointerX + CHIP_OFFSET_PX}px, ${
      this.pointerY + CHIP_OFFSET_PX
    }px)`;
  }

  private clear(): void {
    this.scroller?.removeEventListener('scroll', this.onScroll);
    if (this.frame !== null) {
      this.view?.cancelAnimationFrame?.(this.frame);
      this.frame = null;
    }
    for (const tab of this.options.tabs) {
      tab.removeAttribute('data-live-shift');
      tab.removeAttribute('data-live-drag');
      tab.style.removeProperty('transform');
    }
    this.chip?.remove();
    this.chip = null;
  }

  /**
   * Records where every tab is drawn right now. Call on drop, BEFORE the
   * reorder renders: once the tabs sit in their new places the drag's
   * transforms are still on them, so measuring then reads positions nobody
   * ever saw and the settle would start with a jump.
   */
  hold(): void {
    if (this.finished) {
      return;
    }
    // The last pointer move may still be waiting for its frame.
    if (this.frame !== null) {
      this.view?.cancelAnimationFrame?.(this.frame);
      this.frame = null;
    }
    this.draw();
    this.held = this.options.tabs.map(
      (tab) => tab.getBoundingClientRect().left,
    );
  }

  /**
   * Ends the drag: every tab moves from where it was drawn to where the
   * layout puts it. Call after the reorder has rendered (having called
   * {@link hold} before it), or straight away when nothing was reordered;
   * the tabs that already sit in their final place do not move at all.
   */
  finish(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    const { dragged, tabs } = this.options;
    const drawn =
      this.held ?? tabs.map((tab) => tab.getBoundingClientRect().left);
    this.clear();
    holdHoverUntilPointerMoves(this.options.bar);
    if (this.reducedMotion) {
      return;
    }
    tabs.forEach((tab, index) => {
      const offset = (drawn[index] ?? 0) - tab.getBoundingClientRect().left;
      if (Math.abs(offset) < 0.5 || typeof tab.animate !== 'function') {
        return;
      }
      if (tab === dragged) {
        // Stays above its neighbours until it has landed.
        tab.setAttribute('data-live-drag', 'settle');
      }
      const animation = tab.animate(
        [
          { transform: `translateX(${offset}px)` },
          { transform: 'translateX(0)' },
        ],
        { duration: SETTLE_DURATION_MS, easing: SETTLE_EASING },
      );
      const landed = (): void => {
        if (tab.getAttribute('data-live-drag') === 'settle') {
          tab.removeAttribute('data-live-drag');
        }
      };
      animation.addEventListener('finish', landed);
      animation.addEventListener('cancel', landed);
    });
  }

  /** Drops every trace at once, with no animation. */
  dispose(): void {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this.clear();
  }
}
