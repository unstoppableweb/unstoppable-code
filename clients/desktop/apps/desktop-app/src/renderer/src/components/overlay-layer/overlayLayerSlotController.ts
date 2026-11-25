import type {
  OverlayLayerFollow,
  OverlayLayerRect,
  OverlayLayerSlot as OverlayLayerSlotType,
} from '@canopy/desktop-shared/types';
import type { InAppNotificationPlacement } from '@canopy/ui-shared';
import { getWindow } from '@canopy/ui-shared/panels';
import {
  BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE,
  BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE,
  subscribeBrowserOverlayTopology,
} from '@/lib/browserNativeOverlay';
import { BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT } from '@/lib/browserViewBounds';
import {
  isOverlayLayerAvailable,
  openOverlayLayer,
  type OverlayLayer,
} from '@/lib/overlayLayer';
import {
  calculateOverlayLayerBounds,
  overlayLayerEdges,
} from './overlayLayerBounds';

const SWIPE_TRANSITION_MS = 450;
// A card playing its exit carries this until it unmounts.
const LEAVING_SELECTOR = '[data-ending-style]';
const OVERLAY_SHADOW_ATTRIBUTES = [
  'data-expanded',
  'data-swipe-dragging',
  'data-swipe-settling',
  'data-swipe-flung',
  'data-ending-style',
];

interface OverlayRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Owns the DOM-adoption and native-view lifecycle for one React portal. The
 * content stays in the opener document until it has measured non-empty for a
 * frame, then its one stable container is adopted into the transparent layer.
 */
export class OverlayLayerSlotController {
  private readonly mainWindow: Window & typeof globalThis;
  private readonly mainDocument: Document;
  private resizeObserver: ResizeObserver | null = null;
  private mutationObserver: MutationObserver | null = null;
  private mutationObserverDocument: Document | null = null;
  private topologyUnsubscribe: (() => void) | null = null;
  private layerLostUnsubscribe: (() => void) | null = null;
  private layer: OverlayLayer | null = null;
  private pendingHideLayer: OverlayLayer | null = null;
  private placement: InAppNotificationPlacement;
  private contentHeight = 0;
  private mainNonEmptyFramePassed = false;
  private evaluationFrame: number | null = null;
  private eligibilityFrame: number | null = null;
  private hideBoundsFrame: number | null = null;
  private shrinkTimer: number | null = null;
  private focusReturnTimer: number | null = null;
  private sentBounds: OverlayLayerRect | null = null;
  private pendingShrinkBounds: OverlayLayerRect | null = null;
  private pendingShrinkFollow: OverlayLayerFollow | undefined = undefined;
  private isDisposed = false;

  private readonly onTopologyChange = (): void => {
    this.scheduleEvaluation();
  };

  private readonly onMainResize = (): void => {
    this.scheduleEvaluation();
  };

  private readonly onBoundsInvalidated = (): void => {
    this.scheduleEvaluation();
  };

  constructor(
    private readonly placeholder: HTMLElement,
    private readonly content: HTMLElement,
    private readonly slot: OverlayLayerSlotType,
    placement: InAppNotificationPlacement,
  ) {
    this.mainWindow = getWindow(placeholder);
    this.mainDocument = placeholder.ownerDocument;
    this.placement = placement;
  }

  start(): void {
    if (this.isDisposed) {
      return;
    }

    this.content.setAttribute('data-testid', 'overlay-layer-content');
    this.setPlaceholderMarker('true');
    this.placeholder.appendChild(this.content);
    this.observeContent();
  }

  updatePlacement(placement: InAppNotificationPlacement): void {
    if (placement === this.placement || this.isDisposed) {
      return;
    }

    this.placement = placement;
    this.scheduleEvaluation();
  }

  dispose(): void {
    if (this.isDisposed) {
      return;
    }

    this.isDisposed = true;
    const activeLayer = this.layer;
    if (activeLayer) {
      this.moveToMain(activeLayer, true, true);
    } else if (this.pendingHideLayer) {
      const pendingHideLayer = this.pendingHideLayer;
      this.cancelPendingHide(pendingHideLayer);
      this.sentBounds = null;
      void pendingHideLayer.setBounds(null);
    }
    this.cancelScheduledWork();
    this.stopNonEmptyMonitoring();
    this.disconnectObservers();
    this.content.remove();
    this.setPlaceholderHeight(null);
    this.placeholder.removeAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE);
  }

  private observeContent(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    const ownerWindow = getWindow(this.content);
    const ResizeObserverConstructor = ownerWindow.ResizeObserver;
    if (typeof ResizeObserverConstructor !== 'function') {
      return;
    }

    this.resizeObserver = new ResizeObserverConstructor((entries) => {
      const entry = entries.find(
        (candidate) => candidate.target === this.content,
      );
      if (!entry) {
        return;
      }

      const borderBoxHeight = entry.borderBoxSize[0]?.blockSize;
      const measuredHeight = borderBoxHeight ?? entry.contentRect.height;
      this.onContentResize(
        Number.isFinite(measuredHeight) ? Math.max(0, measuredHeight) : 0,
      );
    });
    this.resizeObserver.observe(this.content, { box: 'border-box' });
  }

  private onContentResize(height: number): void {
    const wasEmpty = this.contentHeight <= 0;
    this.contentHeight = height;

    if (height <= 0) {
      // The stack stops reserving room for a card as soon as it starts to
      // leave. Moving the card to the main document then would cancel its
      // exit and put it under the browser, so wait until it has unmounted.
      if (this.layer && this.hasAttributeInContent(LEAVING_SELECTOR)) {
        return;
      }
      this.onContentEmpty();
      return;
    }

    this.startNonEmptyMonitoring();
    if (
      wasEmpty ||
      this.mutationObserverDocument !== this.content.ownerDocument
    ) {
      this.observeLayerMotionAttributes();
    }
    if (wasEmpty && this.content.ownerDocument === this.mainDocument) {
      this.mainNonEmptyFramePassed = false;
      this.scheduleEligibilityFrame();
      return;
    }

    this.scheduleEvaluation();
  }

  private onContentEmpty(): void {
    this.mainNonEmptyFramePassed = false;
    this.cancelEligibilityFrame();
    this.stopNonEmptyMonitoring();
    if (this.layer) {
      this.moveToMain(this.layer, true, false);
    }
  }

  private startNonEmptyMonitoring(): void {
    if (this.topologyUnsubscribe) {
      return;
    }

    // Only while the slot holds something, so it keeps hearing every change.
    this.topologyUnsubscribe = subscribeBrowserOverlayTopology(
      this.onTopologyChange,
      { everyChange: () => true },
    );
    this.mainWindow.addEventListener('resize', this.onMainResize);
    this.mainWindow.addEventListener(
      BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
      this.onBoundsInvalidated,
    );
  }

  private stopNonEmptyMonitoring(): void {
    this.topologyUnsubscribe?.();
    this.topologyUnsubscribe = null;
    this.mainWindow.removeEventListener('resize', this.onMainResize);
    this.mainWindow.removeEventListener(
      BROWSER_VIEW_BOUNDS_INVALIDATED_EVENT,
      this.onBoundsInvalidated,
    );
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.mutationObserverDocument = null;
  }

  private scheduleEligibilityFrame(): void {
    this.cancelEligibilityFrame();
    this.eligibilityFrame = this.mainWindow.requestAnimationFrame(() => {
      this.eligibilityFrame = null;
      if (
        this.isDisposed ||
        this.contentHeight <= 0 ||
        this.content.ownerDocument !== this.mainDocument
      ) {
        return;
      }

      this.mainNonEmptyFramePassed = true;
      this.cancelEvaluationFrame();
      this.evaluate();
    });
  }

  private cancelEligibilityFrame(): void {
    if (this.eligibilityFrame !== null) {
      this.mainWindow.cancelAnimationFrame(this.eligibilityFrame);
      this.eligibilityFrame = null;
    }
  }

  private scheduleEvaluation(): void {
    if (
      this.isDisposed ||
      this.contentHeight <= 0 ||
      this.evaluationFrame !== null
    ) {
      return;
    }

    this.evaluationFrame = this.mainWindow.requestAnimationFrame(() => {
      this.evaluationFrame = null;
      this.evaluate();
    });
  }

  private evaluate(): void {
    if (this.isDisposed || this.contentHeight <= 0) {
      return;
    }

    if (this.layer?.isLost()) {
      this.handleLayerLoss(this.layer);
      return;
    }

    const hasBrowserViewUnderCorner = this.intersectsAvailableBrowserView();
    if (!hasBrowserViewUnderCorner) {
      if (this.layer) {
        this.moveToMain(this.layer, true, false);
      }
      return;
    }

    if (this.layer) {
      this.updateLayerGeometry(this.layer);
      return;
    }

    if (!this.mainNonEmptyFramePassed || !isOverlayLayerAvailable(this.slot)) {
      return;
    }

    const layer = openOverlayLayer(this.slot);
    if (!layer) {
      return;
    }

    this.beginLayering(layer);
  }

  private intersectsAvailableBrowserView(): boolean {
    const placeholderRect = this.placeholder.getBoundingClientRect();
    if (placeholderRect.width <= 0 || placeholderRect.height <= 0) {
      return false;
    }

    return Array.from(
      this.mainDocument.querySelectorAll<HTMLElement>(
        `[${BROWSER_NATIVE_VIEW_AVAILABLE_ATTRIBUTE}="true"]`,
      ),
    ).some((browserArea) =>
      hasPositiveIntersection(
        placeholderRect,
        browserArea.getBoundingClientRect(),
      ),
    );
  }

  private beginLayering(layer: OverlayLayer): void {
    this.cancelPendingHide(layer);
    this.layer = layer;
    this.layerLostUnsubscribe = layer.onLost(() => {
      this.handleLayerLoss(layer);
    });

    const rect = this.placeholder.getBoundingClientRect();
    const bounds = this.calculateBounds(rect);

    // Publish bounds before adopting the content so the transparent view is
    // already raised and correctly clipped when the first child pixels move.
    this.setPlaceholderHeight(this.contentHeight);
    this.setPlaceholderMarker('false');
    this.applyPosition(rect, bounds);
    this.sendBounds(layer, bounds);
    layer.root.appendChild(this.content);
    this.observeContent();
    this.observeLayerMotionAttributes();
    this.attachLayerFocus(layer);
  }

  private updateLayerGeometry(layer: OverlayLayer): void {
    if (layer !== this.layer) {
      return;
    }

    // For bottom-anchored corners, changing this spacer height moves its top
    // edge. Publish the new height before measuring so the native bounds cover
    // the same layout that the moved stack will paint in this frame.
    this.setPlaceholderHeight(this.contentHeight);
    const rect = this.placeholder.getBoundingClientRect();
    const bounds = this.calculateBounds(rect);
    this.setPlaceholderMarker('false');
    this.applyPosition(rect, bounds);
    this.scheduleBoundsUpdate(layer, bounds, this.calculateFollow());
  }

  /** How the bounds just measured move with the window, for main. */
  private calculateFollow(): OverlayLayerFollow {
    return {
      viewport: {
        width: Math.max(0, Math.ceil(this.mainWindow.innerWidth)),
        height: Math.max(0, Math.ceil(this.mainWindow.innerHeight)),
      },
      edges: overlayLayerEdges(
        this.placement,
        this.hasAttributeInContent('[data-expanded]'),
        this.hasAttributeInContent(
          '[data-swipe-dragging], [data-swipe-settling], [data-swipe-flung]',
        ),
      ),
    };
  }

  private calculateBounds(rect: DOMRect): OverlayLayerRect {
    return calculateOverlayLayerBounds(
      rect,
      this.placement,
      this.mainWindow.innerWidth,
      this.mainWindow.innerHeight,
      this.hasAttributeInContent('[data-expanded]'),
      this.hasAttributeInContent(
        '[data-swipe-dragging], [data-swipe-settling], [data-swipe-flung]',
      ),
    );
  }

  private hasAttributeInContent(selector: string): boolean {
    return (
      this.content.matches(selector) ||
      this.content.querySelector(selector) !== null
    );
  }

  private applyPosition(rect: DOMRect, bounds: OverlayLayerRect): void {
    this.content.style.position = 'absolute';
    this.content.style.width = `${Math.max(0, rect.width)}px`;
    this.content.style.pointerEvents = 'none';

    if (this.placement.endsWith('right')) {
      this.content.style.left = '';
      this.content.style.right = `${bounds.x + bounds.width - rect.right}px`;
    } else {
      this.content.style.left = `${rect.left - bounds.x}px`;
      this.content.style.right = '';
    }

    if (this.placement.startsWith('top')) {
      this.content.style.top = `${rect.top - bounds.y}px`;
      this.content.style.bottom = '';
    } else {
      this.content.style.top = '';
      this.content.style.bottom = `${bounds.y + bounds.height - rect.bottom}px`;
    }
  }

  private setPlaceholderMarker(value: 'true' | 'false'): void {
    if (
      this.placeholder.getAttribute(BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE) !==
      value
    ) {
      this.placeholder.setAttribute(
        BROWSER_NATIVE_VIEW_OVERLAY_ATTRIBUTE,
        value,
      );
    }
  }

  private setPlaceholderHeight(height: number | null): void {
    const nextHeight = height === null ? '' : `${height}px`;
    if (this.placeholder.style.height === nextHeight) {
      return;
    }
    if (height === null) {
      this.placeholder.style.removeProperty('height');
    } else {
      this.placeholder.style.height = nextHeight;
    }
  }

  private observeLayerMotionAttributes(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.mutationObserverDocument = null;
    const ownerWindow = getWindow(this.content);
    const MutationObserverConstructor = ownerWindow.MutationObserver;
    if (typeof MutationObserverConstructor !== 'function') {
      return;
    }

    this.mutationObserver = new MutationObserverConstructor(() => {
      if (this.contentHeight > 0) {
        this.scheduleEvaluation();
      } else if (!this.hasAttributeInContent(LEAVING_SELECTOR)) {
        // The last leaving card has finished its exit and unmounted.
        this.onContentEmpty();
      }
    });
    this.mutationObserverDocument = this.content.ownerDocument;
    this.mutationObserver.observe(this.content, {
      attributes: true,
      attributeFilter: OVERLAY_SHADOW_ATTRIBUTES,
      // Child removals report a leaving card unmounting.
      childList: true,
      subtree: true,
    });
  }

  private scheduleBoundsUpdate(
    layer: OverlayLayer,
    nextBounds: OverlayLayerRect,
    follow: OverlayLayerFollow,
  ): void {
    if (sameBounds(nextBounds, this.sentBounds)) {
      this.cancelPendingShrink();
      return;
    }
    if (sameBounds(nextBounds, this.pendingShrinkBounds)) {
      return;
    }

    this.cancelPendingShrink();
    if (boundsExpands(this.sentBounds, nextBounds)) {
      this.sendBounds(layer, nextBounds, follow);
      return;
    }

    this.pendingShrinkBounds = nextBounds;
    this.pendingShrinkFollow = follow;
    this.shrinkTimer = this.mainWindow.setTimeout(() => {
      this.shrinkTimer = null;
      const pendingBounds = this.pendingShrinkBounds;
      const pendingFollow = this.pendingShrinkFollow;
      this.pendingShrinkBounds = null;
      this.pendingShrinkFollow = undefined;
      if (layer !== this.layer || !pendingBounds) {
        return;
      }

      this.sendBounds(layer, pendingBounds, pendingFollow);
    }, SWIPE_TRANSITION_MS);
  }

  private cancelPendingShrink(): void {
    if (this.shrinkTimer !== null) {
      this.mainWindow.clearTimeout(this.shrinkTimer);
      this.shrinkTimer = null;
    }
    this.pendingShrinkBounds = null;
    this.pendingShrinkFollow = undefined;
  }

  private sendBounds(
    layer: OverlayLayer,
    bounds: OverlayLayerRect | null,
    follow?: OverlayLayerFollow,
  ): void {
    if (
      layer !== this.layer &&
      !(bounds === null && layer === this.pendingHideLayer)
    ) {
      return;
    }
    if (sameBounds(bounds, this.sentBounds)) {
      return;
    }

    this.sentBounds = bounds;
    void layer.setBounds(bounds, follow);
  }

  private attachLayerFocus(layer: OverlayLayer): void {
    const onMainKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'F6' && this.layer === layer) {
        void layer.focus('layer');
      }
    };
    const onLayerFocusOut = (event: FocusEvent): void => {
      if (event.relatedTarget !== null || this.layer !== layer) {
        return;
      }

      this.cancelFocusReturnTimer(layer);
      this.focusReturnTimer = layer.window.setTimeout(() => {
        this.focusReturnTimer = null;
        if (this.layer !== layer || layer.isLost()) {
          return;
        }

        try {
          const activeElement = layer.document.activeElement;
          if (
            layer.document.hasFocus() &&
            (activeElement === null || activeElement === layer.document.body)
          ) {
            void layer.focus('main');
          }
        } catch {
          // A closed child window can become unreadable between focusout and
          // this deferred check. Layer loss owns the fallback in that case.
        }
      }, 0);
    };

    this.mainWindow.addEventListener('keydown', onMainKeyDown, true);
    layer.document.addEventListener('focusout', onLayerFocusOut);
    this.layerFocusCleanup = (): void => {
      this.mainWindow.removeEventListener('keydown', onMainKeyDown, true);
      layer.document.removeEventListener('focusout', onLayerFocusOut);
      this.cancelFocusReturnTimer(layer);
    };
  }

  private layerFocusCleanup: (() => void) | null = null;

  private cancelFocusReturnTimer(layer: OverlayLayer): void {
    if (this.focusReturnTimer !== null) {
      layer.window.clearTimeout(this.focusReturnTimer);
      this.focusReturnTimer = null;
    }
  }

  private moveToMain(
    layer: OverlayLayer,
    sendHideBounds: boolean,
    immediateHide: boolean,
  ): void {
    if (layer !== this.layer) {
      return;
    }

    const hadLayerFocus = this.layerHasFocus(layer);
    this.layer = null;
    this.layerLostUnsubscribe?.();
    this.layerLostUnsubscribe = null;
    this.layerFocusCleanup?.();
    this.layerFocusCleanup = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.mutationObserverDocument = null;
    this.cancelPendingShrink();
    this.cancelEvaluationFrame();

    // Adopt back first; then restore ordinary-flow geometry before React can
    // render another descendant into its stable opener-realm portal target.
    this.placeholder.appendChild(this.content);
    this.clearLayeredContentStyles();
    this.setPlaceholderMarker('true');
    this.setPlaceholderHeight(null);
    this.observeContent();
    if (this.contentHeight > 0 && !this.isDisposed) {
      this.observeLayerMotionAttributes();
    }

    if (hadLayerFocus) {
      void layer.focus('main');
    }

    if (sendHideBounds) {
      if (immediateHide) {
        this.cancelPendingHide(layer);
        this.sentBounds = null;
        void layer.setBounds(null);
      } else {
        this.scheduleHideBounds(layer);
      }
    }
  }

  private layerHasFocus(layer: OverlayLayer): boolean {
    try {
      return layer.document.hasFocus();
    } catch {
      return false;
    }
  }

  private clearLayeredContentStyles(): void {
    this.content.style.removeProperty('position');
    this.content.style.removeProperty('width');
    this.content.style.removeProperty('pointer-events');
    this.content.style.removeProperty('left');
    this.content.style.removeProperty('right');
    this.content.style.removeProperty('top');
    this.content.style.removeProperty('bottom');
  }

  private scheduleHideBounds(layer: OverlayLayer): void {
    this.cancelPendingHide(layer);
    this.pendingHideLayer = layer;
    this.hideBoundsFrame = this.mainWindow.requestAnimationFrame(() => {
      this.hideBoundsFrame = null;
      if (this.pendingHideLayer !== layer || this.layer === layer) {
        return;
      }

      // A topology trigger can request re-layering in the same frame as this
      // deferred hide. Decide at the frame boundary before hiding so a slot
      // that is still needed can reuse its open layer without an IPC flash.
      if (
        this.contentHeight > 0 &&
        this.mainNonEmptyFramePassed &&
        this.intersectsAvailableBrowserView() &&
        isOverlayLayerAvailable(this.slot)
      ) {
        this.evaluate();
        if (this.layer === layer) {
          return;
        }
      }

      this.pendingHideLayer = null;
      this.sentBounds = null;
      void layer.setBounds(null);
    });
  }

  private cancelPendingHide(layer: OverlayLayer): void {
    if (this.pendingHideLayer === layer) {
      if (this.hideBoundsFrame !== null) {
        this.mainWindow.cancelAnimationFrame(this.hideBoundsFrame);
        this.hideBoundsFrame = null;
      }
      this.pendingHideLayer = null;
    }
  }

  private handleLayerLoss(layer: OverlayLayer): void {
    if (layer !== this.layer) {
      return;
    }

    this.cancelScheduledWork();
    this.layer = null;
    this.layerLostUnsubscribe = null;
    this.layerFocusCleanup?.();
    this.layerFocusCleanup = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.mutationObserverDocument = null;
    this.cancelPendingShrink();
    this.pendingHideLayer = null;
    this.sentBounds = null;
    this.placeholder.appendChild(this.content);
    this.clearLayeredContentStyles();
    this.setPlaceholderMarker('true');
    this.setPlaceholderHeight(null);
    this.observeContent();
    if (this.contentHeight > 0) {
      this.observeLayerMotionAttributes();
    }
  }

  private cancelEvaluationFrame(): void {
    if (this.evaluationFrame !== null) {
      this.mainWindow.cancelAnimationFrame(this.evaluationFrame);
      this.evaluationFrame = null;
    }
  }

  private cancelScheduledWork(): void {
    this.cancelEvaluationFrame();
    this.cancelEligibilityFrame();
    if (this.hideBoundsFrame !== null) {
      this.mainWindow.cancelAnimationFrame(this.hideBoundsFrame);
      this.hideBoundsFrame = null;
    }
    this.pendingHideLayer = null;
    this.cancelPendingShrink();
    if (this.focusReturnTimer !== null && this.layer) {
      this.layer.window.clearTimeout(this.focusReturnTimer);
      this.focusReturnTimer = null;
    }
  }

  private disconnectObservers(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
  }
}

function hasPositiveIntersection(a: OverlayRect, b: OverlayRect): boolean {
  return (
    a.width > 0 &&
    a.height > 0 &&
    b.width > 0 &&
    b.height > 0 &&
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  );
}

function sameBounds(
  a: OverlayLayerRect | null,
  b: OverlayLayerRect | null,
): boolean {
  return (
    a === b ||
    (a !== null &&
      b !== null &&
      a.x === b.x &&
      a.y === b.y &&
      a.width === b.width &&
      a.height === b.height)
  );
}

function boundsExpands(
  current: OverlayLayerRect | null,
  next: OverlayLayerRect,
): boolean {
  if (current === null) {
    return true;
  }

  return (
    next.x < current.x ||
    next.y < current.y ||
    next.x + next.width > current.x + current.width ||
    next.y + next.height > current.y + current.height
  );
}
