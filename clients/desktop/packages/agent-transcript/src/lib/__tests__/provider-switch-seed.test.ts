import type { PersistedChatBlock, PersistedChatMessage } from '../../types';
import {
  PROVIDER_SWITCH_SEED_FENCE,
  PROVIDER_SWITCH_SEED_TOOL_TEXT_LIMIT,
  providerSwitchSeedBudget,
  renderProviderSwitchSeed,
} from '../provider-switch-seed';

let sequence = 0;
function message(
  role: PersistedChatMessage['role'],
  blocks: PersistedChatBlock[],
  extra: Partial<PersistedChatMessage> = {},
): PersistedChatMessage {
  sequence += 1;
  return { id: `m${sequence}`, role, blocks, timestamp: sequence, ...extra };
}
const text = (value: string): PersistedChatBlock => ({
  type: 'text',
  text: value,
});

describe('provider switch seed (CAN-6445)', () => {
  it("renders the conversation in Agentic Core's seed format and carries nothing provider-bound", () => {
    const seed = renderProviderSwitchSeed({
      contextWindowTokens: 200_000,
      messages: [
        message('system', [text('Global instructions.')]),
        message('user', [
          text('Fix the failing test.'),
          {
            type: 'file_references',
            references: [
              {
                absolutePath: '/repo/a.test.ts',
                displayPath: 'a.test.ts',
              },
            ],
          },
        ]),
        message('assistant', [
          { type: 'thinking', text: 'secret reasoning' },
          text('Reading it.'),
          {
            type: 'tool_use',
            toolUseId: 't1',
            toolName: 'Read',
            input: '{"path":"a.test.ts"}',
          },
          {
            type: 'tool_result',
            toolUseId: 't1',
            toolName: 'Read',
            output: 'expect(1).toBe(2)',
            isError: false,
          },
        ]),
        message('assistant', [text('Child chatter.')], {
          parentToolUseId: 't1',
        }),
        message('user', [text('Hidden orchestration.')], { hidden: true }),
        message('assistant', [text('Changed it to toBe(1).')]),
      ],
    });
    expect(seed).toEqual({
      text: [
        PROVIDER_SWITCH_SEED_FENCE,
        '',
        [
          'User:\nFix the failing test.\nFiles: /repo/a.test.ts',
          'Assistant:\nReading it.\n[tool call Read] {"path":"a.test.ts"}',
          '[tool result Read] expect(1).toBe(2)',
          'Assistant:\nChanged it to toBe(1).',
        ].join('\n\n'),
        '',
        '---',
      ].join('\n'),
      includedMessages: 3,
      omittedMessages: 0,
    });
    expect(seed.text).not.toContain('secret reasoning');
    expect(seed.text).not.toContain('Child chatter');
    expect(seed.text).not.toContain('Hidden orchestration');
    expect(seed.text).not.toContain('Global instructions');
  });

  it('carries nothing before the first assistant reply', () => {
    expect(
      renderProviderSwitchSeed({
        contextWindowTokens: undefined,
        messages: [message('user', [text('Hello')])],
      }),
    ).toEqual({ text: '', includedMessages: 0, omittedMessages: 0 });
  });

  it('cuts huge tool text before dropping any turn', () => {
    const huge = 'x'.repeat(PROVIDER_SWITCH_SEED_TOOL_TEXT_LIMIT * 5);
    const seed = renderProviderSwitchSeed({
      contextWindowTokens: 200_000,
      messages: [
        message('user', [text('First question')]),
        message('assistant', [
          {
            type: 'tool_use',
            toolUseId: 't',
            toolName: 'Bash',
            input: huge,
          },
          {
            type: 'tool_result',
            toolUseId: 't',
            toolName: 'Bash',
            output: huge,
            isError: false,
          },
        ]),
      ],
    });
    expect(seed.omittedMessages).toBe(0);
    expect(seed.text).toContain('First question');
    expect(seed.text).not.toContain(huge);
    expect(seed.text.match(/\[\.\.\. truncated\]/g)).toHaveLength(2);
  });

  it("carries Claude's tool results and Codex's tool activity from their system rows", () => {
    const seed = renderProviderSwitchSeed({
      contextWindowTokens: 200_000,
      messages: [
        message('user', [text('List the files.')]),
        // Claude: the call on the assistant row, the result on its own system row.
        message('assistant', [
          {
            type: 'tool_use',
            toolUseId: 'c1',
            toolName: 'Bash',
            input: '{"command":"ls"}',
          },
        ]),
        message('system', [
          {
            type: 'tool_result',
            toolUseId: 'c1',
            toolName: 'Bash',
            output: 'a.ts b.ts',
            isError: false,
          },
        ]),
        // Codex: one system row holds both the call and its result.
        message('system', [
          {
            type: 'tool_use',
            toolUseId: 'x1',
            toolName: 'command_execution',
            input: 'cat a.ts',
          },
          {
            type: 'tool_result',
            toolUseId: 'x1',
            toolName: 'command_execution',
            output: 'export {}',
            isError: false,
          },
        ]),
        message('system', [text('Turn took 4 s.')]),
        message('assistant', [text('Two files.')]),
      ],
    });
    expect(seed.text).toContain(
      'Assistant:\n[tool call Bash] {"command":"ls"}\n\n[tool result Bash] a.ts b.ts',
    );
    expect(seed.text).toContain(
      '[tool call command_execution] cat a.ts\n\n[tool result command_execution] export {}',
    );
    expect(seed.text).not.toContain('Turn took');
    expect(seed.omittedMessages).toBe(0);
  });

  it("carries a delegation's prompt and result while its child rows stay out", () => {
    const seed = renderProviderSwitchSeed({
      contextWindowTokens: 200_000,
      messages: [
        message('user', [text('Review the PR.')]),
        message('assistant', [
          {
            type: 'delegated_agent_call',
            agentBlockId: 'd1',
            runGeneration: 1,
            sequence: 1,
            parentHarnessId: 'claude',
            parentTurnId: 'turn',
            parentToolCallId: 'call',
            createdAt: 1,
            selectedModelId: 'm',
            runtimeModelId: 'm',
            targetHarnessId: 'codex',
            description: 'reviewer',
            prompt: 'Review diff',
            executionMode: 'foreground',
            delegationId: 'del',
            status: 'completed',
            outputTruncated: false,
            finalText: 'Found one bug.',
          },
          {
            type: 'codex_agent_call',
            agentBlockId: 'codex-agent-s1',
            callId: 's1',
            tool: 'spawnAgent',
            status: 'completed',
            senderThreadId: 'root',
            receiverThreadIds: ['child'],
            prompt: 'Check tests',
            agentsStates: {
              child: { status: 'completed', message: 'Tests pass.' },
            },
          },
        ]),
        message('assistant', [text('Delegate chatter.')], {
          parentBlockId: 'd1',
        }),
        message('assistant', [text('One bug, tests pass.')]),
      ],
    });
    expect(seed.text).toContain(
      'Assistant:\n[tool call subagent reviewer] Review diff\n[tool call subagent spawnAgent] Check tests',
    );
    expect(seed.text).toContain('[tool result subagent] Found one bug.');
    expect(seed.text).toContain('[tool result subagent] Tests pass.');
    expect(seed.text).not.toContain('Delegate chatter');
  });

  it('drops the oldest turns with a count and keeps the newest whole', () => {
    // A 1,000-token window gives a 1,000-character budget.
    expect(providerSwitchSeedBudget(1_000)).toBe(1_000);
    const long = (label: string): string => `${label} ${'y'.repeat(400)}`;
    const messages = [
      message('user', [text(long('oldest question'))]),
      message('assistant', [text(long('oldest answer'))]),
      message('user', [text(long('newest question'))]),
      message('assistant', [text(long('newest answer'))]),
    ];
    const seed = renderProviderSwitchSeed({
      contextWindowTokens: 1_000,
      messages,
    });
    expect(seed.omittedMessages).toBe(2);
    expect(seed.includedMessages).toBe(2);
    expect(
      seed.text.startsWith(
        `${PROVIDER_SWITCH_SEED_FENCE} [2 earlier messages omitted.]`,
      ),
    ).toBe(true);
    expect(seed.text).toContain(long('newest question'));
    expect(seed.text).toContain(long('newest answer'));
    expect(seed.text).not.toContain('oldest');
  });

  it('shares Agentic Core budget: a quarter of the window at four characters a token, capped', () => {
    expect(providerSwitchSeedBudget(200_000)).toBe(200_000);
    expect(providerSwitchSeedBudget(undefined)).toBe(200_000);
    expect(providerSwitchSeedBudget(1_000_000)).toBe(400_000);
  });
});
