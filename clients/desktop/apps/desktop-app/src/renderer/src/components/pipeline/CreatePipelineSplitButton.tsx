import { ControlButton } from '@canopy/ui-shared/components';
import {
  SplitActionDivider,
  WorkflowCreateCluster,
} from '@canopy/ui-shared/components';
import { type JSX, useId, useRef, useState } from 'react';
import { Menu } from '@canopy/ui-shared';
import {
  ActionMenuItems,
  ActionMenuRowStyle,
} from '@canopy/ui-shared/components';
import { ChevronDownIcon } from '@canopy/ui-shared/icons';
import { Hammer2Icon } from '@canopy/ui-shared/icons/AppIcons';

export interface CreatePipelineSplitButtonProps {
  /** Main action: start the AI interview in a new Cowork chat (CAN-3487). */
  onStartInterview: () => void;
  /** Chevron menu action: open the manual pipeline builder. */
  onBuildManually: () => void;
  /** Disables the split action while the interview chat is being created. */
  interviewPending?: boolean;
  /**
   * Prefix for the three stable test ids: `<prefix>` (main action),
   * `<prefix>-menu` (chevron) and `<prefix>-manual` (Build manually row).
   */
  testIdPrefix: string;
}

/**
 * The Pipelines tab's "New pipeline" split action. The main button
 * starts an AI interview in a normal Cowork chat; the chevron keeps the
 * manual builder one step away behind "Build manually".
 */
export function CreatePipelineSplitButton({
  onStartInterview,
  onBuildManually,
  interviewPending = false,
  testIdPrefix,
}: CreatePipelineSplitButtonProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const clusterRef = useRef<HTMLDivElement>(null);
  const chevronRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  return (
    <WorkflowCreateCluster
      ref={clusterRef}
      data-testid={`${testIdPrefix}-split`}
    >
      <ControlButton
        type="button"
        onClick={() => {
          setMenuOpen(false);
          onStartInterview();
        }}
        disabled={interviewPending}
        aria-busy={interviewPending}
        data-testid={testIdPrefix}
        presentation="workflow-create"
      >
        New workflow
      </ControlButton>
      <SplitActionDivider />
      <ControlButton
        ref={chevronRef}
        type="button"
        onClick={() => setMenuOpen((open) => !open)}
        aria-label="More ways to create a workflow"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-controls={menuOpen ? menuId : undefined}
        disabled={interviewPending}
        data-testid={`${testIdPrefix}-menu`}
        presentation="workflow-create-menu"
      >
        <ChevronDownIcon size="sm" aria-hidden="true" />
      </ControlButton>
      <Menu
        id={menuId}
        open={menuOpen}
        onOpenChange={setMenuOpen}
        anchorRef={clusterRef}
        returnFocusRef={chevronRef}
        outsidePressBoundaryRef={clusterRef}
        placement="bottom-right"
        role="menu"
        aria-label="Create workflow options"
        data-testid={`${testIdPrefix}-options`}
        className="w-48"
      >
        <ActionMenuRowStyle>
          <ActionMenuItems
            items={[
              {
                key: 'manual',
                label: 'Build manually',
                icon: <Hammer2Icon />,
                testId: `${testIdPrefix}-manual`,
              },
            ]}
            onSelect={(): void => {
              setMenuOpen(false);
              chevronRef.current?.focus({ preventScroll: true });
              onBuildManually();
            }}
          />
        </ActionMenuRowStyle>
      </Menu>
    </WorkflowCreateCluster>
  );
}
