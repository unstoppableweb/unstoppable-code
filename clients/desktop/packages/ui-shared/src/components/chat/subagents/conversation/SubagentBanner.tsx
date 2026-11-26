import { ControlButton } from '../../../../primitives/Button';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../../../lib/replay-privacy';
import type { JSX, ReactNode } from 'react';
import { type SubagentNode, type SubagentTree } from '@canopy/agent-transcript';
import type { SubagentChangeTotals } from '../types';
import {
  SUBAGENT_BANNER_HIDE_DETAILS_LABEL,
  SUBAGENT_BANNER_LINEAGE_LABEL,
  SUBAGENT_BANNER_SHOW_DETAILS_LABEL,
  SUBAGENT_FACTS_ERROR_MAX_LENGTH,
  subagentFailureText,
  subagentFilesCountLabel,
  subagentProviderLabel,
  subagentStatusDetail,
  subagentWorkspaceShortLabel,
} from '../subagent-copy';
import { SubagentChangesLabel } from '../common/SubagentChangesLabel';
import { SubagentHarnessMark } from '../common/SubagentHarnessMark';
import { SubagentIcon } from '../../../../icons/SubagentIcon';
import { SubagentWorkflowMark } from '../common/SubagentWorkflow';
import {
  SubagentStatusGlyph,
  subagentStatusInk,
} from '../common/SubagentStatusGlyph';
import {
  ChatIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronTopMediumIcon,
  WorktreeIcon,
} from '../../../../icons/AppIcons';
import { HeaderActionButton } from '../../../HeaderActionButton';
import type { SubagentLineageTarget } from './SubagentLineageDetails';

export interface SubagentBannerProps {
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  /** Ancestors ordered from the root chat toward the selected node. */
  readonly ancestors: readonly SubagentNode[];
  readonly changeTotals?: SubagentChangeTotals;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onOpenLineage: (target: SubagentLineageTarget) => void;
  readonly children?: ReactNode;
}

function LineageBreadcrumb({
  tree,
  node,
  ancestors,
  onOpenLineage,
}: Pick<
  SubagentBannerProps,
  'tree' | 'node' | 'ancestors' | 'onOpenLineage'
>): JSX.Element {
  return (
    <nav
      aria-label={SUBAGENT_BANNER_LINEAGE_LABEL}
      className="flex min-w-0 items-center gap-1 text-xs fg-tertiary"
    >
      <ChatIcon size={12} aria-hidden className="shrink-0" />
      <ControlButton
        type="button"
        presentation="subagent-lineage"
        onClick={(): void =>
          onOpenLineage({
            kind: 'root',
            id: tree.root.id,
            title: tree.root.title,
          })
        }
        data-testid={`subagent-chat-breadcrumb-${tree.root.id}`}
      >
        <span className={REPLAY_MASK_CLASS} title={tree.root.title}>
          {tree.root.title}
        </span>
      </ControlButton>
      {ancestors.map((ancestor) => (
        <span
          key={ancestor.id}
          className={
            ancestor.kind === 'workflow-phase'
              ? 'flex shrink-0 items-center gap-1'
              : 'flex min-w-0 items-center gap-1'
          }
        >
          <ChevronRightIcon size="sm" aria-hidden className="shrink-0" />
          {ancestor.kind === 'workflow-run' ? (
            <SubagentWorkflowMark size={12} />
          ) : null}
          <ControlButton
            type="button"
            presentation="subagent-ancestor"
            appearance={{ workflowPhase: ancestor.kind === 'workflow-phase' }}
            onClick={(): void =>
              onOpenLineage({
                kind: ancestor.kind,
                id: ancestor.id,
                title: ancestor.title,
              })
            }
            data-testid={`subagent-chat-breadcrumb-${ancestor.id}`}
          >
            <span className={REPLAY_MASK_CLASS} title={ancestor.title}>
              {ancestor.title}
            </span>
          </ControlButton>
        </span>
      ))}
      <ChevronRightIcon size="sm" aria-hidden className="shrink-0" />
      <span className="inline-flex shrink-0 fg-accent">
        <SubagentIcon size={12} />
      </span>
      <span
        className={`${REPLAY_MASK_CLASS} min-w-0 truncate fg-primary`}
        title={node.title}
      >
        {node.title}
      </span>
    </nav>
  );
}

function FactsLine({
  node,
  changeTotals,
}: {
  readonly node: SubagentNode;
  readonly changeTotals?: SubagentChangeTotals;
}): JSX.Element {
  const status = subagentStatusDetail(node);
  const error = subagentFailureText(node);
  const shortError =
    error && error.length <= SUBAGENT_FACTS_ERROR_MAX_LENGTH
      ? error
      : undefined;
  const model =
    node.modelLabel ??
    node.snapshot?.routeSnapshot?.runtimeModelLabel ??
    node.snapshot?.routeSnapshot?.selectedModelLabel ??
    node.snapshot?.routeSnapshot?.runtimeModelId ??
    node.snapshot?.routeSnapshot?.selectedModelId;
  const thinking =
    node.thinkingLevel ?? node.snapshot?.routeSnapshot?.effectiveThinkingLevel;
  const harness = node.harnessId ?? node.snapshot?.routeSnapshot?.harnessId;
  const provider = subagentProviderLabel(node.kind);
  const workspace =
    node.kind === 'managed' ? subagentWorkspaceShortLabel(node) : null;
  return (
    <div className="flex min-w-0 items-center gap-2 text-xs fg-secondary">
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <SubagentStatusGlyph status={node.status} />
          <span className={subagentStatusInk(node.status)}>
            {status}
            {shortError ? (
              <span className={`${REPLAY_BLOCK_CLASS} fg-secondary`}>
                {' · '}
                {shortError}
              </span>
            ) : null}
          </span>
        </span>
        {model || harness || thinking ? (
          <span className="fg-quaternary">·</span>
        ) : null}
        {model || harness || thinking ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <SubagentHarnessMark harnessId={harness} />
            {model ? (
              <span className="min-w-0 break-words fg-secondary">{model}</span>
            ) : null}
            {thinking ? <span className="fg-tertiary">{thinking}</span> : null}
          </span>
        ) : null}
        {provider || workspace ? (
          <span className="fg-quaternary">·</span>
        ) : null}
        {provider ? (
          <span className="shrink-0 fg-tertiary">{provider}</span>
        ) : null}
        {node.kind === 'managed' && node.workspace === 'shared' ? (
          <span className="shrink-0 fg-tertiary">{workspace}</span>
        ) : null}
        {node.kind === 'managed' && node.workspace === 'isolated' ? (
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 fg-tertiary">
            <WorktreeIcon size={12} aria-hidden />
            <span className="shrink-0">{workspace}</span>
            {changeTotals ? (
              <>
                <SubagentChangesLabel
                  additions={changeTotals.additions}
                  deletions={changeTotals.deletions}
                />
                <span>
                  {subagentFilesCountLabel(changeTotals.filesChanged)}
                </span>
              </>
            ) : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Sticky, disclosure-style subagent chat identity and facts header (D17). */
export function SubagentBanner({
  tree,
  node,
  ancestors,
  changeTotals,
  expanded,
  onToggle,
  onOpenLineage,
  children,
}: SubagentBannerProps): JSX.Element {
  return (
    <div
      className="sticky top-0 z-10 shrink-0 border-b bg-secondary"
      data-testid="subagent-chat-banner"
    >
      <div className="flex flex-col gap-1.5 px-4 py-2.5">
        <LineageBreadcrumb
          tree={tree}
          node={node}
          ancestors={ancestors}
          onOpenLineage={onOpenLineage}
        />
        <div className="flex min-w-0 items-center gap-2">
          <FactsLine node={node} changeTotals={changeTotals} />
          <HeaderActionButton
            iconOnly
            tone="neutral"
            aria-label={
              expanded
                ? SUBAGENT_BANNER_HIDE_DETAILS_LABEL
                : SUBAGENT_BANNER_SHOW_DETAILS_LABEL
            }
            aria-expanded={expanded}
            data-testid="subagent-chat-details-toggle"
            onClick={onToggle}
          >
            {expanded ? (
              <ChevronTopMediumIcon size={14} aria-hidden />
            ) : (
              <ChevronDownIcon size={14} aria-hidden />
            )}
          </HeaderActionButton>
        </div>
      </div>
      {expanded ? children : null}
    </div>
  );
}
