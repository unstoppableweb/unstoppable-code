import { useLayoutEffect, useState, type JSX, type ReactNode } from 'react';
import { ChatIcon, MessageIcon } from '@canopy/ui-shared/icons';
import {
  SelectionActionPill,
  Surface,
  type SelectionPillAction,
} from '@canopy/ui-shared/components';
import {
  SpecimenCell,
  SpecimenGrid,
  SpecimenPanel,
} from './componentsLabParts';

function noop(): void {}

function copyWorks(): boolean {
  return true;
}

const COPY: SelectionPillAction = {
  key: 'copy',
  tooltip: 'Copy the selected text',
  testId: 'lab-selection-copy',
  onCopy: copyWorks,
};

const SEND: SelectionPillAction = {
  key: 'send',
  label: 'Send to chat',
  tooltip: 'Send the selected text to the chat composer',
  icon: <ChatIcon aria-hidden="true" />,
  testId: 'lab-selection-send',
  onSelect: noop,
};

const SEND_WITH_SHORTCUT: SelectionPillAction = { ...SEND, shortcut: '⌘L' };

const COMMENT: SelectionPillAction = {
  key: 'comment',
  label: 'Comment',
  tooltip: 'Comment on the selected text',
  icon: <MessageIcon aria-hidden="true" />,
  testId: 'lab-selection-comment',
  onSelect: noop,
};

function PaneStage({ children }: { children: ReactNode }): JSX.Element {
  return <div className="relative h-11 w-90">{children}</div>;
}

function WindowPillStage(): JSX.Element {
  const [selection, setSelection] = useState<HTMLDivElement | null>(null);
  const [selectionRect, setSelectionRect] = useState<DOMRect | null>(null);
  const [selectionVisible, setSelectionVisible] = useState(false);
  useLayoutEffect((): (() => void) | void => {
    const view = selection?.ownerDocument.defaultView;
    if (!selection || !view) return;
    const updateRect = (): void => {
      setSelectionRect(selection.getBoundingClientRect());
    };
    updateRect();
    const observer = new ResizeObserver(updateRect);
    observer.observe(selection);
    const intersection = new IntersectionObserver(
      ([entry]): void => {
        setSelectionVisible((entry?.intersectionRatio ?? 0) > 0);
      },
      { threshold: [0, 0.0001] },
    );
    intersection.observe(selection);
    view.addEventListener('scroll', updateRect, {
      capture: true,
      passive: true,
    });
    view.addEventListener('resize', updateRect);
    return (): void => {
      observer.disconnect();
      intersection.disconnect();
      view.removeEventListener('scroll', updateRect, true);
      view.removeEventListener('resize', updateRect);
    };
  }, [selection]);

  return (
    <div className="pt-12">
      <div
        ref={setSelection}
        data-testid="lab-selection-window"
        className="w-90 text-xs fg-secondary"
      >
        <Surface variant="inset" padding="tight">
          Selected text in an editor
        </Surface>
      </div>
      {selection && selectionRect && selectionVisible ? (
        <SelectionActionPill
          placement={{
            kind: 'window',
            rect: selectionRect,
            ownerDocument: selection.ownerDocument,
          }}
          role="menu"
          aria-label="Selected text actions"
          actions={[SEND, COPY, COMMENT]}
        />
      ) : null}
    </div>
  );
}

function SelectionPillSheet(): JSX.Element {
  return (
    <SpecimenPanel title="SelectionActionPill">
      <SpecimenGrid min={480}>
        <SpecimenCell label="In a pane: Copy and an action with its shortcut">
          <PaneStage>
            <SelectionActionPill
              placement={{ kind: 'pane', top: 6, left: 6 }}
              actions={[COPY, SEND_WITH_SHORTCUT]}
            />
          </PaneStage>
        </SpecimenCell>
        <SpecimenCell label="In a pane: Copy only">
          <PaneStage>
            <SelectionActionPill
              placement={{ kind: 'pane', top: 6, left: 6 }}
              actions={[COPY]}
            />
          </PaneStage>
        </SpecimenCell>
        <SpecimenCell label="In a pane: three actions, as a menu">
          <PaneStage>
            <SelectionActionPill
              placement={{ kind: 'pane', top: 6, left: 6 }}
              role="menu"
              aria-label="Selected text actions"
              actions={[SEND, COPY, COMMENT]}
            />
          </PaneStage>
        </SpecimenCell>
        <SpecimenCell label="Floating over the window, clear of the selection">
          <WindowPillStage />
        </SpecimenCell>
      </SpecimenGrid>
    </SpecimenPanel>
  );
}

/** The pill of actions a text selection offers, in a pane or over the window. */
export function OverlayOptionsSpecimen(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <SelectionPillSheet />
    </div>
  );
}
