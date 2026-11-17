// CAN-6701 golden: the desktop workflow host checks the owner's AI gateway
// requirement for models that never pass through AI Credits or gateway
// routing. It resolves the owner as the organization policy does, refuses a
// native-only invocation (the daemon owner request resolves one here), and
// refuses an Ollama model on the Codex harness before Ollama starts. Claude
// invocations keep their routed check and are not asked here.
import {
  initClaudeModels,
  initOllamaModels,
} from '@canopy/execution-engine/model-catalog';

const mockCheck = jest.fn();
const mockOwner = jest.fn();
const mockOllamaCodex = jest.fn();
jest.mock('../../lib/model-gateway-state', () => ({
  checkModelGatewayRoute: (...args: unknown[]): unknown => mockCheck(...args),
}));
jest.mock('../../agents/work-owner', () => ({
  resolveBackgroundWorkOwner: (...args: unknown[]): unknown =>
    mockOwner(...args),
}));
jest.mock('../../agent-runs/claude-worker-runtime', () => ({
  getClaudeWorkerRuntime: (): unknown => ({
    prepareInvocation: (): Promise<unknown> => Promise.resolve({}),
  }),
}));
jest.mock('../../agents/ai-credits-routing', () => ({
  resolveAiCreditsRoutingOverride: (): Promise<null> => Promise.resolve(null),
}));
jest.mock('../../ollama/codex-compatible', () => ({
  resolveCodexCompatibleOllamaInvocation: (...args: unknown[]): unknown =>
    mockOllamaCodex(...args),
}));

import {
  checkDesktopPipelineNativeGatewayRoute,
  resolveDesktopPipelineHarnessInvocation,
} from '../pipeline-model-invocation';

const ORG = { kind: 'organization', organizationId: 'org-1' };
const REQUIRED = 'Acme requires model traffic to use its configured gateway.';
const UNAVAILABLE = "Acme's AI gateway settings are unavailable.";

initClaudeModels([{ id: 'sonnet', label: 'Sonnet' }]);
initOllamaModels([
  {
    id: 'ollama-qwen3',
    rawModelId: 'qwen3',
    label: 'Qwen 3',
    show: { capabilities: ['completion', 'tools'] },
  },
]);

beforeEach(() => {
  mockCheck.mockReset();
  mockOwner.mockReset();
  mockOllamaCodex.mockReset();
  mockOwner.mockResolvedValue(ORG);
  mockOllamaCodex.mockResolvedValue({
    source: 'ollama',
    harness: 'codex',
    runtimeModel: 'qwen3',
    aiCreditsRouted: false,
  });
});

it('resolves the owner as the organization policy does and returns the refusal', async () => {
  mockCheck.mockResolvedValue({ ok: false, message: REQUIRED });
  await expect(
    checkDesktopPipelineNativeGatewayRoute('antigravity:gemini-3.8-flash', {
      projectId: 'p',
      worktreeId: 'w',
      executionContext: 'automation',
    }),
  ).resolves.toEqual({ ok: false, message: REQUIRED });
  expect(mockOwner).toHaveBeenCalledWith(
    { projectId: 'p', worktreeId: 'w' },
    'automation',
  );
  expect(mockCheck).toHaveBeenCalledWith('antigravity:gemini-3.8-flash', ORG);
});

it('allows an unrestricted owner', async () => {
  mockCheck.mockResolvedValue({ ok: true, orgRoute: false });
  await expect(
    checkDesktopPipelineNativeGatewayRoute('cursor:auto', {}),
  ).resolves.toEqual({ ok: true });
});

it.each([
  ['antigravity', 'antigravity:gemini-3.8-flash'],
  ['copilot', 'copilot:gpt-5'],
  ['opencode', 'opencode:any'],
  ['cursor', 'cursor:auto'],
] as const)(
  'refuses a %s invocation when the gateway settings are unavailable',
  async (harness, model) => {
    mockCheck.mockResolvedValue({ ok: false, message: UNAVAILABLE });
    await expect(
      resolveDesktopPipelineHarnessInvocation(model, {
        harness,
        workspaceId: 'p',
        worktreeId: 'w',
      }),
    ).rejects.toThrow(UNAVAILABLE);
    expect(mockOwner).toHaveBeenCalledWith(
      { projectId: 'p', worktreeId: 'w' },
      undefined,
    );
  },
);

it('refuses an Ollama model on the Codex harness before Ollama starts', async () => {
  mockCheck.mockResolvedValue({ ok: false, message: REQUIRED });
  await expect(
    resolveDesktopPipelineHarnessInvocation('ollama-qwen3', {
      harness: 'codex',
      workspaceId: 'p',
      worktreeId: 'w',
    }),
  ).rejects.toThrow(REQUIRED);
  expect(mockCheck).toHaveBeenCalledWith('ollama-qwen3', ORG);
  expect(mockOllamaCodex).not.toHaveBeenCalled();
});

it('runs an Ollama model on the Codex harness for an unrestricted owner', async () => {
  mockCheck.mockResolvedValue({ ok: true, orgRoute: false });
  await expect(
    resolveDesktopPipelineHarnessInvocation('ollama-qwen3', {
      harness: 'codex',
    }),
  ).resolves.toMatchObject({ source: 'ollama', harness: 'codex' });
  expect(mockOllamaCodex).toHaveBeenCalledTimes(1);
});

it('does not ask about a Claude invocation, which keeps its routed check', async () => {
  mockCheck.mockResolvedValue({ ok: false, message: 'never consulted' });
  await resolveDesktopPipelineHarnessInvocation('sonnet', {
    harness: 'claude',
  });
  expect(mockCheck).not.toHaveBeenCalled();
});
