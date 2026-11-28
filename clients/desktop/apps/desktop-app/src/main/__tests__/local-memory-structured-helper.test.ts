import type * as InlineHelperRuns from './helpers/inline-helper-runs';
import { initClaudeModels } from '@canopy/desktop-shared/types';
jest.mock('../canopy-runtime/desktop-runtime', () => ({
  getActiveDesktopRuntimeIfAccepting: jest.fn(),
}));
jest.mock('../helper-runs/helper-runs', () => {
  const { inlineHelperRunsModule } = jest.requireActual<
    typeof InlineHelperRuns
  >('./helpers/inline-helper-runs');
  return inlineHelperRunsModule();
});
let mockHarness = 'claude';
jest.mock('../ollama/helper-invocation', () => ({
  resolveHelperInvocation: jest.fn(() =>
    Promise.resolve({
      harness: mockHarness,
      providerType: mockHarness,
      dispose: jest.fn(),
    }),
  ),
}));
jest.mock('../memory/local/model-policy', () => ({
  isLocalMemoryModelBlockedByPolicy: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('@canopy/memory-store/memory-files', () => ({
  ensureOwnerOnlyDir: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/helper-observed-task', () => ({
  markObservedHelperTaskAiCreditsRouted: jest.fn(),
}));
jest.mock('../integration/structured-helper-dispatch', () => ({
  runStructuredHelper: jest.fn(() =>
    Promise.resolve({ value: { ok: true }, usage: { inputTokens: 2 } }),
  ),
  codexStructuredHelperRunner: {
    run: jest.fn(() =>
      Promise.resolve({ value: { ok: true }, usage: { inputTokens: 2 } }),
    ),
  },
  structuredHelperReportOnlyPermission: jest.fn(),
}));
import { runLocalMemoryStructuredHelper } from '../memory/local/structured-helper';
const helpers = jest.requireMock<
  ReturnType<typeof InlineHelperRuns.inlineHelperRunsModule>
>('../helper-runs/helper-runs');
it('runs each local memory helper as one helper run of its kind', async () => {
  initClaudeModels([{ id: 'haiku', label: 'Haiku' }]);
  const anySignal: unknown = expect.any(AbortSignal);
  const kinds = [
    'local-memory-consolidation',
    'local-memory-chat-profile',
    'skill-suggestion-scan',
  ] as const;
  for (const harness of ['claude', 'codex'])
    for (const kind of kinds) {
      mockHarness = harness;
      helpers.runs.length = 0;
      const result = await runLocalMemoryStructuredHelper({
        taskKey: 'task',
        kind,
        label: 'Memory',
        scopeDir: '/memory',
        workspaceId: 'workspace',
        helperModel: { model: 'haiku', thinkingLevel: 'off' },
        systemPrompt: 'System',
        userMessage: 'Prompt',
        schema: {},
        isResult: (value: unknown): value is { ok: boolean } =>
          typeof value === 'object' && value !== null,
      });
      expect(result.usage.inputTokens).toBe(2);
      expect(helpers.runs).toHaveLength(1);
      expect(helpers.runs[0]).toMatchObject({
        kind: kind.replaceAll('-', '_'),
        model: 'haiku',
        scope: { workspaceId: 'workspace' },
        origin: 'system',
        signal: anySignal,
      });
    }
});
