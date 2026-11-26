import {
  useContext,
  useEffect,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import {
  WORKFLOWS_PAGE_DESCRIPTION,
  WORKFLOWS_PAGE_TITLE,
  WorkflowsTabBar,
} from '@canopy/ui-shared/components';
import type { WorkflowsTabId } from '@canopy/ui-shared/lib';
import { useNavigationStore } from '@/stores/navigationStore';
import { PageHeader } from '@canopy/ui-shared/primitives/PageHeader';
import { WorkflowsTabContext } from './workflowsTabContext';

export interface WorkflowsPageHeaderProps {
  /** The current tab's own actions, placed beside the heading. */
  readonly actions?: ReactNode;
  /** Counts beside the tab labels, in the selected context. */
  readonly counts?: Readonly<Partial<Record<WorkflowsTabId, number>>>;
}

/**
 * The Workflows heading and its Runs | Schedule | Library tab bar. A view
 * that needs full-page chrome (the pipeline editor) leaves it out.
 */
export function WorkflowsPageHeader({
  actions,
  counts,
}: WorkflowsPageHeaderProps): JSX.Element {
  const context = useContext(WorkflowsTabContext);
  const tab = context?.tab ?? 'workflows';
  const keyboardTarget = context?.keyboardTarget ?? null;
  const navigate = useNavigationStore((s) => s.navigate);
  // Read once: this bar takes focus on mount if a keyboard change brought it.
  const [focusSelectedOnMount] = useState(
    () => keyboardTarget !== null && keyboardTarget.current === tab,
  );
  useEffect(() => {
    if (keyboardTarget?.current === tab) keyboardTarget.current = null;
  }, [keyboardTarget, tab]);
  return (
    <PageHeader
      title={WORKFLOWS_PAGE_TITLE}
      description={WORKFLOWS_PAGE_DESCRIPTION}
      actions={actions}
      tabs={
        <WorkflowsTabBar
          value={tab}
          counts={counts}
          focusSelectedOnMount={focusSelectedOnMount}
          onChange={(next, source): void => {
            if (next === tab) return;
            if (keyboardTarget) {
              keyboardTarget.current = source === 'keyboard' ? next : null;
            }
            navigate(next);
          }}
        />
      }
    />
  );
}
