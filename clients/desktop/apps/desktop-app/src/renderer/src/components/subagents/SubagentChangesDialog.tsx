import { useEffect, useState, type JSX } from 'react';
import type { DelegationWorkspaceChanges } from '@canopy/protocol/delegation';
import {
  Button,
  DialogModal,
  Disclosure,
  DELEGATED_AGENT_CHANGES_FAILED_LABEL,
  DELEGATED_AGENT_DIFF_SHORTENED_LABEL,
  DELEGATED_AGENT_LOADING_CHANGES_LABEL,
  DELEGATED_AGENT_NO_CHANGES_LABEL,
  DELEGATED_AGENT_NO_DIFF_LABEL,
  DELEGATED_AGENT_REFRESH_CHANGES_LABEL,
  delegatedAgentChangesShownLabel,
  ErrorState,
  CodeBlock,
} from '@canopy/ui-shared/components';
import type { SubagentHostScope } from './subagent-scope';

export interface SubagentChangesTarget {
  readonly scope: SubagentHostScope;
  readonly delegationId: string;
  readonly revision: string;
  readonly title: string;
}

export interface SubagentChangesDialogProps {
  readonly target: SubagentChangesTarget | null;
  readonly onClose: () => void;
}

type ChangesState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly changes: DelegationWorkspaceChanges };

function ChangedFiles({
  changes,
  onRefresh,
}: {
  readonly changes: DelegationWorkspaceChanges;
  readonly onRefresh: () => void;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-col gap-3 px-6 py-4">
      {changes.files.length === 0 ? (
        <p className="text-s fg-secondary">
          {DELEGATED_AGENT_NO_CHANGES_LABEL}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {changes.files.map((file) => (
            <Disclosure
              key={file.path}
              variant="box"
              label={<span className="font-mono">{file.path}</span>}
              meta={file.change}
              dataTestId="subagent-changed-file"
            >
              {file.diff ? (
                <CodeBlock variant="panel" className="max-h-[50vh]">
                  {file.diff}
                </CodeBlock>
              ) : (
                <p className="text-xs fg-secondary">
                  {DELEGATED_AGENT_NO_DIFF_LABEL}
                </p>
              )}
              {file.diffTruncated ? (
                <p className="text-xs fg-tertiary">
                  {DELEGATED_AGENT_DIFF_SHORTENED_LABEL}
                </p>
              ) : null}
            </Disclosure>
          ))}
        </div>
      )}
      {changes.omittedFiles ? (
        <p className="text-xs fg-tertiary">
          {delegatedAgentChangesShownLabel(changes.files.length)}
        </p>
      ) : null}
      <div>
        <Button size="compact" variant="secondary" onClick={onRefresh}>
          {DELEGATED_AGENT_REFRESH_CHANGES_LABEL}
        </Button>
      </div>
    </div>
  );
}

/** Shows the bounded diff list for an isolated managed delegate. */
export function SubagentChangesDialog({
  target,
  onClose,
}: SubagentChangesDialogProps): JSX.Element | null {
  const [state, setState] = useState<ChangesState>({ status: 'loading' });
  const [retryCount, setRetryCount] = useState(0);

  useEffect(() => {
    if (!target) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    void window.api.managedDelegation
      .changes({
        projectId: target.scope.projectId,
        worktreeId: target.scope.worktreeId,
        delegationId: target.delegationId,
        revision: target.revision,
      })
      .then((result): void => {
        if (cancelled) return;
        setState(
          result.ok
            ? { status: 'ready', changes: result.changes }
            : { status: 'failed' },
        );
      })
      .catch((): void => {
        if (!cancelled) setState({ status: 'failed' });
      });
    return (): void => {
      cancelled = true;
    };
  }, [retryCount, target]);

  if (!target) return null;

  const retry = (): void => setRetryCount((count) => count + 1);
  return (
    <DialogModal
      inset="flush"
      title={`Changes from ${target.title}`}
      onClose={onClose}
      maxWidth="4xl"
      dataTestId="subagent-changes-dialog"
    >
      {state.status === 'loading' ? (
        <p className="px-6 py-4 text-s fg-secondary" role="status">
          {DELEGATED_AGENT_LOADING_CHANGES_LABEL}
        </p>
      ) : state.status === 'failed' ? (
        <ErrorState
          space="panel"
          message={DELEGATED_AGENT_CHANGES_FAILED_LABEL}
          onRetry={retry}
        />
      ) : (
        <ChangedFiles changes={state.changes} onRefresh={retry} />
      )}
    </DialogModal>
  );
}
