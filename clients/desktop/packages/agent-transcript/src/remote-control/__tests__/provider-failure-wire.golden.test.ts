import type { RemoteControlChatMessage } from '@canopy/protocol/remote-control/shell';
import { parseCanopyProxyError } from '@canopy/protocol/llm-gateway';
import { runtimeChatEventToRemoteControlMessage } from '../runtime-chat-projection';

// These are provider envelopes on the existing chat:event wire. A missing item
// must not erase the failure from the paired Portal transcript.
describe('Portal routed provider failure wire contract', () => {
  it.each(['credentials_unavailable', 'upstream_unavailable'])(
    'publishes %s once per execution across error and terminal frames',
    (code) => {
      const body = JSON.stringify({
        error: { canopy_proxy: 'CANOPY_AI_CREDITS_PROXY', code },
      });
      const project = (
        event: unknown,
        execution = 'execution-1',
      ): RemoteControlChatMessage | null =>
        runtimeChatEventToRemoteControlMessage({
          scope: 'worktree',
          chatId: 'chat-1',
          fallbackMessageId: 'prompt-1:assistant',
          data: {
            type: 'codex',
            event,
            canopy_execution_turn_id: execution,
            canopy_turn_user_message_id: 'prompt-1',
          },
        });
      const error = project({ type: 'error', message: body });
      const terminal = project({
        type: 'turn.failed',
        error: { message: body },
      });
      expect(error).toMatchObject({
        chatId: 'chat-1',
        role: 'assistant',
        status: 'failed',
        errorCode: code,
      });
      expect(terminal).toMatchObject({
        messageId: error?.messageId,
        status: 'failed',
        errorCode: code,
      });
      expect(parseCanopyProxyError(error?.text ?? '')?.code).toBe(code);
      expect(parseCanopyProxyError(terminal?.text ?? '')?.code).toBe(code);
      const rows = new Map(
        [error, terminal].map((row) => [row?.messageId, row]),
      );
      expect(rows.size).toBe(1);
      expect(
        project({ type: 'error', message: body }, 'execution-2')?.messageId,
      ).not.toBe(error?.messageId);
    },
  );

  it('keeps legacy prompt identity and unknown marked failures recoverable', () => {
    const row = runtimeChatEventToRemoteControlMessage({
      scope: 'worktree',
      chatId: 'chat-1',
      fallbackMessageId: 'prompt-1:assistant',
      data: {
        type: 'codex',
        event: {
          type: 'turn.failed',
          error: {
            message: JSON.stringify({
              error: {
                canopy_proxy: 'CANOPY_AI_CREDITS_PROXY',
                code: 'future',
              },
            }),
          },
        },
      },
    });
    expect(row).toMatchObject({
      messageId: 'prompt-1:assistant',
      status: 'failed',
      errorCode: 'proxy_internal_error',
    });
  });

  it('does not publish unmarked native diagnostic text as a refusal', () => {
    expect(
      runtimeChatEventToRemoteControlMessage({
        scope: 'worktree',
        chatId: 'chat-1',
        fallbackMessageId: 'prompt-1:assistant',
        data: {
          type: 'codex',
          event: {
            type: 'error',
            message: 'unexpected status 401 at http://localhost',
          },
        },
      }),
    ).toBeNull();
  });
});
