import { getRawOpenCodeModelId } from '@canopy/execution-engine/lib/opencode-models';
import {
  createCliOpenCodeAccount,
  stripCliAccountCredentials,
} from './cli-account';
import { readCliOpenCodeOwner } from './cli-owner';
import {
  openCliOpenCodeInference,
  type CliOpenCodeInference,
} from './cli-inference';
import {
  prepareCliOpenCodeCapabilities,
  type CliOpenCodeCapabilityServices,
} from './cli-capabilities';
import type { OpenCodeApprovalPort } from './tool-approval';
import { openCliOpenCodeRollout, type CliOpenCodeRollout } from './cli-rollout';
import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { hostOperatingSystem } from '@canopy/core-platform/host-platform';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { getCanopyDataDir } from '@canopy/execution-engine/canopy-paths';
import {
  getEnhancedEnv,
  getOpenCodeRuntimeRootDir,
} from '@canopy/execution-engine/pipelines/config-paths';
import type { OpenCodePromptRunnerRequest } from '@canopy/execution-engine/node/pipelines/executor/types';
import type { ApprovalRule } from '../../types';
import { withoutStepStartupInjection } from '../provider-process/step-environment';
import type { OpenCodePromptHost } from '../pipelines/opencode-prompt-runner';
import {
  createHeadlessApprovalSession,
  readHeadlessPreferences,
} from '../approvals/headless-session';
import { verifyManagedExecutable } from '../managed-runtime/verification';
import { spawnProviderProcessDirect } from '../provider-process/spawn';
import {
  getOpenCodeRuntimeArtifact,
  opencodeExecutableName,
} from './runtime-metadata';
import { readOpenCodeProviderConfig } from './provider-config';
import { authorizeOpenCodeNativeTool } from './tool-approval';

/** Desktop-closed host; account credentials stay in the trusted brokers. */
export function createCliOpenCodeHost(
  request: OpenCodePromptRunnerRequest,
  services?: CliOpenCodeCapabilityServices,
): OpenCodePromptHost {
  let active:
    | {
        signal: AbortSignal;
        authorize: OpenCodePromptHost['authorize'];
        approval: OpenCodeApprovalPort;
        capabilityServices?: CliOpenCodeCapabilityServices;
      }
    | undefined;
  return {
    async open(parentSignal) {
      const controller = new AbortController();
      const signal = AbortSignal.any([parentSignal, controller.signal]);
      let rollout: CliOpenCodeRollout | undefined;
      let watcher: FSWatcher | undefined;
      let inference: CliOpenCodeInference | undefined;
      let validateCapabilities: (() => Promise<void>) | undefined;
      const flag = CLIENT_FEATURE_FLAGS.canopyDesktopOpenCodeHarness;
      const assertEnabled = async (): Promise<void> => {
        signal.throwIfAborted();
        const preferences = await readHeadlessPreferences().catch(
          () => undefined,
        );
        if (preferences?.opencodeEnabled !== true)
          throw new Error(
            'Connect OpenCode in Settings before running this workflow.',
          );
        const enabled =
          rollout?.isEnabled() ?? flag.launchDarklyDisabledDefaultValue;
        if (enabled !== true)
          throw new Error(
            'OpenCode is unavailable under the current rollout policy.',
          );
        signal.throwIfAborted();
      };
      const close = async (): Promise<void> => {
        controller.abort();
        active = undefined;
        watcher?.close();
        await inference?.close();
        await rollout?.close();
      };
      try {
        await assertEnabled();
        rollout = await openCliOpenCodeRollout(signal, () =>
          controller.abort(),
        );
        await assertEnabled();
        watcher = watch(
          getCanopyDataDir(),
          { persistent: false },
          (_event, name) => {
            if (!name || name.toString() === 'preferences.json')
              void assertEnabled().catch(() => controller.abort());
          },
        );
        watcher.on('error', () => controller.abort());
        const account = createCliOpenCodeAccount();
        const owner = await readCliOpenCodeOwner(request);
        const assertCurrent = async (checkAccount = true): Promise<void> => {
          try {
            await assertEnabled();
            if ((await readCliOpenCodeOwner(request)).binding !== owner.binding)
              throw new Error(
                'The workspace owner changed during this workflow.',
              );
            if (account && checkAccount)
              await account.assertModel(request.model, owner.owner, signal);
            else if (!account && owner.owner.kind === 'organization')
              throw new Error(
                'An authenticated CLI account is required to enforce organization policy.',
              );
            await validateCapabilities?.();
            signal.throwIfAborted();
          } catch (error) {
            controller.abort();
            throw error;
          }
        };
        await assertCurrent();
        if (!getRawOpenCodeModelId(request.model)) {
          if (!account)
            throw new Error(
              'An authenticated CLI account is required to use AI Credits.',
            );
          inference = await openCliOpenCodeInference({
            model: request.model,
            account,
            owner,
            signal,
            assertCurrent: () => assertCurrent(false),
          });
        }
        const artifact = getOpenCodeRuntimeArtifact();
        if (!artifact)
          throw new Error('OpenCode is not available on this device.');
        const executable = join(
          getOpenCodeRuntimeRootDir(),
          artifact.version,
          opencodeExecutableName(),
        );
        await verifyManagedExecutable(
          executable,
          artifact.executableSha256,
          signal,
          'OpenCode',
        );
        const env = stripCliAccountCredentials({
          ...getEnhancedEnv({
            includeCanopySecrets: false,
            environment: false,
          }),
          ...Object.fromEntries(
            Object.entries(
              withoutStepStartupInjection(request.environment),
            ).filter(
              ([key]) =>
                ![
                  'HOME',
                  'USERPROFILE',
                  'HOMEDRIVE',
                  'HOMEPATH',
                  'HOMESHARE',
                ].includes(key.toUpperCase()),
            ),
          ),
        });
        const providerConfig = inference
          ? {}
          : await readOpenCodeProviderConfig(env);
        const approval = createHeadlessApprovalSession({
          cwd: request.cwd,
          projectId: request.projectId,
          mode:
            request.permissionPreset === 'dangerous_all'
              ? 'full-access'
              : 'ask',
          sessionRules:
            request.permissionPreset === 'read_only' ||
            request.permissionPreset === 'plan'
              ? ['Read', 'Grep', 'Glob'].map<ApprovalRule>((toolName) => ({
                  id: `opencode-cli-read:${toolName}`,
                  behavior: 'allow',
                  target: { kind: 'tool', toolName },
                  origin: 'settings',
                  createdAt: new Date().toISOString(),
                }))
              : [],
          signal,
        });
        await assertEnabled();
        active = {
          signal,
          capabilityServices: services
            ? {
                ...services,
                account,
                owner: owner.owner,
                assertCurrent,
                setCapabilityValidator: (validate): void => {
                  validateCapabilities = validate;
                },
              }
            : undefined,
          approval: {
            async check(
              check,
              display,
            ): ReturnType<OpenCodeApprovalPort['check']> {
              await assertCurrent();
              const outcome = await approval.check(check, display);
              await assertCurrent();
              return outcome;
            },
          },
          async authorize(
            input,
            turnSignal,
          ): ReturnType<OpenCodePromptHost['authorize']> {
            try {
              await assertCurrent();
              const decision = await authorizeOpenCodeNativeTool(input, {
                cwd: request.cwd,
                approval,
                planMode: request.permissionPreset === 'plan',
                signal: AbortSignal.any([signal, turnSignal]),
                toolUseId: randomUUID(),
              });
              await assertCurrent();
              return decision;
            } catch {
              return { decision: 'deny' };
            }
          },
        };
        return {
          executable,
          env,
          providerConfig,
          ...(inference
            ? {
                inferenceRoute: inference.route,
                supportedThinkingLevels: inference.supportedThinkingLevels,
                failureError: inference.failureError.bind(inference),
              }
            : {}),
          signal,
          close,
          spawnProcess: spawnProviderProcessDirect,
          processOwner: { kind: 'pipeline', id: randomUUID() },
          runtimeIdentity: {
            version: artifact.version,
            executableSha256: artifact.executableSha256,
            platform: `${hostOperatingSystem()}-${process.arch}`,
          },
        };
      } catch (error) {
        await close();
        throw error;
      }
    },
    async prepareCapabilities(profile, signal) {
      if (!active || active.signal.aborted)
        throw new Error('OpenCode session is unavailable.');
      return prepareCliOpenCodeCapabilities(
        request,
        profile,
        AbortSignal.any([signal, active.signal]),
        active.approval,
        active.capabilityServices,
      );
    },
    authorize(input, signal) {
      return !active || active.signal.aborted
        ? Promise.resolve({ decision: 'deny' })
        : active.authorize(input, signal);
    },
  };
}
