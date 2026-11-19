import { memo, type JSX } from 'react';
import type {
  AgentArtifactReceiptV1,
  GitHubWorkflowRunArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/desktop-shared/types';
import { AgentActivitySection } from '@canopy/ui-app/agent-activity';
import { isCapabilityTileReceipt } from '@canopy/ui-shared/components';
import { AgentArtifactCard } from './AgentArtifactCard';
import { GitHubWorkflowRunArtifactCard } from './GitHubWorkflowRunArtifactCard';
import { PipelineRunArtifactCard } from './PipelineRunArtifactCard';

interface AgentActivityChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

interface DesktopAgentActivitySectionProps {
  artifacts: readonly AgentArtifactReceiptV1[];
  variant: 'active' | 'completed';
  defaultExpanded?: boolean;
  chatTarget?: AgentActivityChatTarget;
  /** The user turn these artifacts belong to; lets cards refresh their carry. */
  ownerUserMessageId?: string;
}

/**
 * Desktop host for the shared Agent activity section: renders the desktop
 * artifact and run cards. Background agents, tasks and live runs are the
 * composer's background drawer's (background drawer D2).
 */
export const DesktopAgentActivitySection = memo(
  function DesktopAgentActivitySection({
    artifacts,
    variant,
    defaultExpanded,
    chatTarget,
    ownerUserMessageId,
  }: DesktopAgentActivitySectionProps): JSX.Element | null {
    // Created and changed items and watched GitHub workflow runs are rows
    // under the section's header. Pipeline runs keep the presentation of the
    // Pipeline Runs panel.
    const artifactItems = artifacts
      .filter(isCapabilityTileReceipt)
      .map((receipt) => (
        <AgentArtifactCard key={receipt.dedupeKey} receipt={receipt} />
      ));
    const pipelineRunItems = artifacts
      .filter(
        (receipt): receipt is PipelineRunArtifactReceiptV1 =>
          receipt.kind === 'pipeline_run',
      )
      .map((receipt) => (
        <PipelineRunArtifactCard
          key={receipt.dedupeKey}
          receipt={receipt}
          chatTarget={chatTarget}
        />
      ));
    const githubRunItems = artifacts
      .filter(
        (receipt): receipt is GitHubWorkflowRunArtifactReceiptV1 =>
          receipt.kind === 'github_workflow_run',
      )
      .map((receipt) => (
        <GitHubWorkflowRunArtifactCard
          key={receipt.dedupeKey}
          receipt={receipt}
          chatTarget={chatTarget}
          ownerUserMessageId={ownerUserMessageId}
        />
      ));
    return (
      <AgentActivitySection
        artifactItems={artifactItems}
        pipelineRunItems={pipelineRunItems}
        githubRunItems={githubRunItems}
        variant={variant}
        defaultExpanded={defaultExpanded}
      />
    );
  },
);
