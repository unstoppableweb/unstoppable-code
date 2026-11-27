import { useEffect, type RefObject } from 'react';
import { getDocument } from '@canopy/ui-shared/panels';
import { suppressNextClick } from '@canopy/ui-shared/lib';

export function useCloseOnOutsideMouseDown(
  active: boolean,
  triggerRef: RefObject<HTMLElement | null>,
  contentRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  includeNestedMenus = false,
): void {
  useEffect((): (() => void) | void => {
    if (!active) return;

    const doc = getDocument(triggerRef.current);

    const handler = (event: MouseEvent): void => {
      const NodeConstructor = doc.defaultView?.Node;
      if (!NodeConstructor || !(event.target instanceof NodeConstructor)) {
        return;
      }

      const insideTrigger =
        triggerRef.current && triggerRef.current.contains(event.target);
      const insideContent =
        contentRef.current && contentRef.current.contains(event.target);
      // Menu flyouts render beside their parent in document.body. Match the
      // shared Menu boundary without changing non-menu popovers.
      const ElementConstructor = doc.defaultView?.Element;
      const insideNestedMenu =
        includeNestedMenus &&
        ElementConstructor &&
        event.target instanceof ElementConstructor &&
        event.target.closest('[data-floating-menu-nested="true"]') !== null;
      if (!insideTrigger && !insideContent && !insideNestedMenu) {
        // The press only dismisses — swallow the click it completes so the
        // element under the pointer is not activated.
        suppressNextClick(doc);
        onClose();
      }
    };

    // Bind to the document that OWNS the trigger, not the ambient main-window
    // `document`. When the composer is popped out to an aux panel window its
    // subtree is DOM-adopted into that window's document, so a main-document
    // listener would never see the outside click (and could close on clicks in
    // the wrong window). `getDocument` falls back to the main document when the
    // trigger lives in the main window, so main-window menus are unaffected.
    doc.addEventListener('mousedown', handler);
    return (): void => doc.removeEventListener('mousedown', handler);
  }, [active, contentRef, onClose, triggerRef, includeNestedMenus]);
}
