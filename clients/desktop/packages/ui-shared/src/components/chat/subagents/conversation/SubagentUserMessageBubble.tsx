import { REPLAY_BLOCK_CLASS } from '../../../../lib/replay-privacy';
import type { JSX, ReactNode } from 'react';
import type { AgentSentInfo } from '@canopy/protocol/remote-control/shell/external-agent-sender';
import { UserBubble } from '../../../UserBubble';
import { SteeringTitle } from '../../SteeringTitle';
import {
  AgentSentTitle,
  type AgentSentReceivingContext,
} from '../../AgentSentTitle';
import { useAgentSentReceivingContext } from '../../AgentSentReceivingContext';

export interface SubagentUserMessageBubbleProps {
  readonly children: ReactNode;
  readonly copyText: string;
  readonly steering?: boolean;
  readonly agentSent?: AgentSentInfo;
  readonly receivingContext?: AgentSentReceivingContext;
}

/** An ordinary user message, titled Steering after a run picks it up. */
export function SubagentUserMessageBubble({
  children,
  copyText,
  steering = false,
  agentSent,
  receivingContext: explicitReceivingContext,
}: SubagentUserMessageBubbleProps): JSX.Element {
  const receivingContext = useAgentSentReceivingContext(
    explicitReceivingContext,
  );
  return (
    <div className="flex justify-end">
      <div className="max-w-full">
        <UserBubble
          copyText={copyText}
          header={
            agentSent || steering ? (
              <>
                {agentSent ? (
                  <AgentSentTitle
                    agentSent={agentSent}
                    receivingContext={receivingContext}
                  />
                ) : null}
                {steering ? <SteeringTitle /> : null}
              </>
            ) : undefined
          }
        >
          <div className={`${REPLAY_BLOCK_CLASS} text-s`}>{children}</div>
        </UserBubble>
      </div>
    </div>
  );
}
