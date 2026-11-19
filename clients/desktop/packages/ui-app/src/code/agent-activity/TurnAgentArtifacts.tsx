'use client';

import { memo, useMemo, type JSX } from 'react';
import type {
  AgentArtifactReceiptV1,
  PipelineRunArtifactReceiptV1,
} from '@canopy/protocol/agent-artifacts';
import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';
import {
  CapabilityTile,
  capabilityTileModel,
  isCapabilityTileReceipt,
  type CapabilityTileAction,
} from '@canopy/ui-shared/components';
import { AgentActivitySection } from './AgentActivitySection';
import { useAgentArtifactTileHost } from './agent-artifact-tile-host';
import { PipelineRunReceiptCard } from './PipelineRunReceiptCard';
import { usePipelineRunReceiptHost } from './pipeline-run-receipt-host';
import { collectTurnAgentArtifacts } from './turn-agent-artifacts';

const NO_HOST_ACTION: CapabilityTileAction = { kind: 'none' };

export interface TurnAgentArtifactsProps {
  /** The turn's assistant messages, in transcript order. */
  readonly messages: readonly RemoteControlChatMessage[];
  /**
   * The receipts to list instead of collecting them from `messages`. A chat
   * view supplies them after placing each run in one turn across the chat
   * (`placeAgentActivity`, CAN-4690).
   */
  readonly receipts?: readonly AgentArtifactReceiptV1[];
}

/**
 * A turn's capability tiles and pipeline run cards inside the shared Agent
 * activity section. Run cards overlay the mounted run host's state on their
 * receipt snapshot. Renders nothing when the turn produced neither.
 */
export const TurnAgentArtifacts = memo(function TurnAgentArtifacts({
  messages,
  receipts: placedReceipts,
}: TurnAgentArtifactsProps): JSX.Element | null {
  const host = useAgentArtifactTileHost();
  const runHost = usePipelineRunReceiptHost();
  const { tiles, runs } = useMemo(() => {
    const receipts = placedReceipts ?? collectTurnAgentArtifacts(messages);
    return {
      tiles: receipts.filter(isCapabilityTileReceipt),
      runs: receipts.filter(
        (receipt): receipt is PipelineRunArtifactReceiptV1 =>
          receipt.kind === 'pipeline_run',
      ),
    };
  }, [messages, placedReceipts]);
  if (tiles.length === 0 && runs.length === 0) return null;
  const items = tiles.map((receipt) => (
    <CapabilityTile
      key={receipt.dedupeKey}
      model={capabilityTileModel(receipt)}
      action={host ? host.resolveAction(receipt) : NO_HOST_ACTION}
      testId={`agent-artifact-${receipt.kind}`}
    />
  ));
  const pipelineRunItems = runs.map((receipt) => (
    <PipelineRunReceiptCard
      key={receipt.dedupeKey}
      receipt={receipt}
      summaries={runHost?.summaries}
      statesById={runHost?.statesById}
      actions={runHost?.actions}
      pending={runHost?.pending}
    />
  ));
  return (
    <AgentActivitySection
      artifactItems={items}
      pipelineRunItems={pipelineRunItems}
      variant="completed"
      defaultExpanded
    />
  );
});
