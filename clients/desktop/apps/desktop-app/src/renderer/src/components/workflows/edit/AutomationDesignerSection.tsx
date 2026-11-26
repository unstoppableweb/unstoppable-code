import {
  useCallback,
  useRef,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  WORKFLOW_DESIGNER_ACTIONS,
  WorkflowDesigner,
  type WorkflowDesignerAction,
  type WorkflowDesignerEntry,
  type WorkflowDesignerSelection,
} from '@canopy/ui-app/workflows';
import { Heading, Surface } from '@canopy/ui-shared/components';
import type { AutomationActionCardModel } from './automationDesignerModel';

const NO_ENTRIES: ReadonlyMap<string, WorkflowDesignerEntry> = new Map();
const NO_SELECTION: WorkflowDesignerSelection = { type: 'none' };
const FIELD_SELECTOR =
  'input:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])';

function ignore(): void {}

export interface AutomationDesignerSectionProps {
  readonly card: AutomationActionCardModel;
  /** When it runs, as the trigger card's title. */
  readonly triggerTitle: string;
  /** The trigger card opens the Trigger section, where its fields are. */
  readonly onOpenTrigger: () => void;
  readonly onOpenWorkflow?: () => void;
  readonly onOpenRun?: () => void;
  /** The Definition fields, the action card's panel. Always mounted. */
  readonly children: ReactNode;
}

/**
 * An automation in the Designer (CAN-4224 phase 06): its trigger card, its
 * one action card, and a "+" that says why nothing can follow. The action
 * card's panel is the Definition form, always open beside the stack, so
 * Save keeps reaching its checks.
 */
export function AutomationDesignerSection({
  card,
  triggerTitle,
  onOpenTrigger,
  onOpenWorkflow,
  onOpenRun,
  children,
}: AutomationDesignerSectionProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  // Its panel is already open: selecting the card moves into it.
  const focusPanel = useCallback((): void => {
    panelRef.current?.querySelector<HTMLElement>(FIELD_SELECTOR)?.focus();
  }, []);
  // Escape from its fields returns to the card, as a pipeline step's panel
  // does. The form stays open beside it, so nothing is lost.
  const returnToCard = useCallback(
    (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      // A nested picker or dialog, portaled out but bubbling through React,
      // handles its own Escape.
      if (
        !(event.target instanceof Node) ||
        !event.currentTarget.contains(event.target)
      )
        return;
      const card = stackRef.current?.querySelector<HTMLElement>(
        '[data-testid="workflow-designer-card"]',
      );
      if (!card) return;
      event.preventDefault();
      card.focus();
    },
    [],
  );
  const link =
    card.workflow !== undefined && onOpenWorkflow
      ? { label: 'Open workflow', onOpen: onOpenWorkflow }
      : card.executionId !== undefined && onOpenRun
        ? { label: 'Open run', onOpen: onOpenRun }
        : undefined;
  const node: WorkflowDesignerAction = {
    kind: 'action',
    key: 'action',
    action: card.action,
    title: card.title,
    ...(card.detail !== undefined ? { detail: card.detail } : {}),
    selected: true,
    onSelect: focusPanel,
    ...(link ? { link } : {}),
    addBlockedReason: card.addBlockedReason,
  };
  return (
    <div
      className="flex flex-col gap-6 lg:flex-row lg:items-start"
      data-testid="automation-designer"
    >
      <div ref={stackRef} className="min-w-0 lg:w-96 lg:shrink-0">
        <WorkflowDesigner
          stack={{ nodes: [node] }}
          selection={NO_SELECTION}
          onClearSelection={ignore}
          trigger={{
            title: triggerTitle,
            selected: false,
            onSelect: onOpenTrigger,
            onDismiss: ignore,
            stepEntries: NO_ENTRIES,
          }}
        />
      </div>
      <Surface
        variant="section"
        className="min-w-0 flex-1"
        data-testid="automation-designer-panel"
        onKeyDown={returnToCard}
      >
        <div ref={panelRef} className="flex flex-col gap-2">
          <Heading level={3} variant="label">
            {WORKFLOW_DESIGNER_ACTIONS[card.action].label}
          </Heading>
          {children}
        </div>
      </Surface>
    </div>
  );
}
