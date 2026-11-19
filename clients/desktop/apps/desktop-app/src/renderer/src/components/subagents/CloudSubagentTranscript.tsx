/**
 * A cloud delegate's subagent chat (CAN-7133). Its rows aren't in the root
 * chat: they're its own stream, read page by page from the web core with
 * the root chat as the source, as its card in that chat reads them, and as
 * the web's subagent chat does. Only a delegate on the root chat's own
 * cards is read; any other shows nothing and asks for nothing.
 */
import { Fragment, memo, useCallback, useMemo, type JSX } from 'react';
import {
  buildSubagentChatTranscript,
  type SubagentNode,
  type SubagentTree,
} from '@canopy/agent-transcript';
import type { DelegatedAgentCallBlock } from '@canopy/agent-transcript/types';
import type { TranscriptReadSource } from '@canopy/app-core';
import { DelegationChildPages, isStreamBackedDelegation } from '@canopy/ui-app';
import {
  SubagentRunDivider,
  type AgentSentReceivingContext,
} from '@canopy/ui-shared';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ChatBlockRenderer } from '@/components/chat/ChatBlockRenderer';
import {
  renderDelegationChildBlock,
  renderDelegationChildRows,
} from '@/components/chat/delegation-child-row-renderer';
import { getDisplayBlockKey } from '@/components/chat/display-block-keys';
import type { DisplayBlock } from '@/components/chat/types';
import type { ChatMessage } from '@/stores/chatStore';
import { SubagentChatTranscript } from './SubagentChatTranscript';
import type { SubagentHostScope } from './subagent-scope';

export interface CloudSubagentTranscriptProps {
  readonly scope: SubagentHostScope;
  readonly rootChatId: string;
  readonly tree: SubagentTree;
  readonly node: SubagentNode;
  readonly rootMessages: readonly ChatMessage[];
  /** Bumps when the web core reads this delegate's lifecycle change. */
  readonly epoch: number;
  readonly streaming: boolean;
  readonly receivingContext: AgentSentReceivingContext;
}

/**
 * The root chat's own card for each of the delegate's runs: a top-level
 * block of that chat, never a card nested in another delegate's rows.
 */
function ownCardsByRun(
  messages: readonly ChatMessage[],
  delegationId: string,
): ReadonlyMap<number, DelegatedAgentCallBlock> {
  const cards = new Map<number, DelegatedAgentCallBlock>();
  for (const message of messages)
    for (const block of message.blocks)
      if (
        block.type === 'delegated_agent_call' &&
        block.delegationId === delegationId
      )
        cards.set(block.runGeneration, block);
  return cards;
}

/**
 * One run's pages. `finalText` is that run's own answer, shown after them:
 * the rows leave out text that repeats it, as on its card. A run drawn from
 * another run's card has none, so nothing of its own is left out.
 */
function CloudRunPages({
  source,
  card,
  runGeneration,
  finalText,
  epoch,
  streaming,
  rootChatId,
}: {
  readonly source: TranscriptReadSource;
  readonly card: DelegatedAgentCallBlock;
  readonly runGeneration: number;
  readonly finalText: string | undefined;
  readonly epoch: number;
  readonly streaming: boolean;
  readonly rootChatId: string;
}): JSX.Element {
  const renderSubBlock = useCallback(
    (block: DisplayBlock, index: number): JSX.Element => (
      <ChatBlockRenderer
        key={getDisplayBlockKey(block, index)}
        block={block}
        streaming={streaming}
        originChatTabId={rootChatId}
        stripAgentCitations
      />
    ),
    [rootChatId, streaming],
  );
  return (
    <>
      <DelegationChildPages
        source={source}
        delegationId={card.delegationId}
        runGeneration={runGeneration}
        hint={{
          epoch,
          ...(card.streamRevision !== undefined
            ? { streamRevision: card.streamRevision }
            : {}),
        }}
        v2Available={true}
        {...(finalText !== undefined ? { finalText } : {})}
        renderRows={(entries, shown) =>
          renderDelegationChildRows(entries, card, renderSubBlock, shown)
        }
        renderBlock={(entry, row) =>
          renderDelegationChildBlock(entry, row, renderSubBlock)
        }
      />
      {finalText !== undefined ? (
        <div className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-col gap-2`}>
          <ChatBlockRenderer
            block={{ type: 'text', text: finalText }}
            streaming={streaming}
            originChatTabId={rootChatId}
            stripAgentCitations
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * Each run's task, then its own pages, read by that run's generation. A run
 * the web core reports beyond the root's cards renders with the latest of
 * them; a delegate with no card on the root has nothing to read.
 */
export const CloudSubagentTranscript = memo(function CloudSubagentTranscript({
  scope,
  rootChatId,
  tree,
  node,
  rootMessages,
  epoch,
  streaming,
  receivingContext,
}: CloudSubagentTranscriptProps): JSX.Element | null {
  const cards = useMemo(
    () => ownCardsByRun(rootMessages, node.id),
    [node.id, rootMessages],
  );
  const source = useMemo<TranscriptReadSource>(
    () => ({
      scope: {
        workspaceId: scope.projectId,
        worktreeId: scope.worktreeId,
        chatId: rootChatId,
      },
    }),
    [rootChatId, scope.projectId, scope.worktreeId],
  );
  const runs = useMemo(() => {
    const latestCard = Array.from(cards.values()).reduce<
      DelegatedAgentCallBlock | undefined
    >(
      (latest, card) =>
        latest === undefined || card.runGeneration > latest.runGeneration
          ? card
          : latest,
      undefined,
    );
    return Array.from(new Set(node.runs.map((run) => run.runGeneration)))
      .sort((left, right) => left - right)
      .flatMap((runGeneration) => {
        const ownCard = cards.get(runGeneration);
        const card = ownCard ?? latestCard;
        if (card === undefined) return [];
        const run = node.runs.find(
          (candidate) => candidate.runGeneration === runGeneration,
        );
        const items = buildSubagentChatTranscript({
          tree,
          node,
          rootMessages,
          runs: [
            {
              runGeneration,
              ...(run?.agentBlockId !== undefined
                ? { agentBlockId: run.agentBlockId }
                : {}),
            },
          ],
        }).items;
        return [{ runGeneration, card, finalText: ownCard?.finalText, items }];
      });
  }, [cards, node, rootMessages, tree]);
  if (node.kind !== 'managed' || runs.length === 0) return null;
  return (
    <>
      {runs.map(({ runGeneration, card, finalText, items }, index) => (
        <Fragment key={runGeneration}>
          {index > 0 ? (
            <SubagentRunDivider runGeneration={runGeneration} />
          ) : null}
          <div
            data-testid="cloud-subagent-run"
            data-run-generation={runGeneration}
            className="contents"
          >
            <SubagentChatTranscript
              items={items}
              originChatTabId={rootChatId}
              receivingContext={receivingContext}
              streaming={streaming}
            />
            {isStreamBackedDelegation(card.transcriptStore) ? (
              <CloudRunPages
                source={source}
                card={card}
                runGeneration={runGeneration}
                finalText={finalText}
                epoch={epoch}
                streaming={streaming}
                rootChatId={rootChatId}
              />
            ) : null}
          </div>
        </Fragment>
      ))}
    </>
  );
});
