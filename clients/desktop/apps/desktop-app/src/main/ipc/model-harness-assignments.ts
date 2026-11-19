import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import {
  IPC_CHANNELS,
  type ModelHarnessAssignmentSnapshot,
  type ResetModelHarnessAssignmentInput,
  type SetModelHarnessAssignmentInput,
  ModelHarnessPolicyError,
  initModelHarnessAssignments,
  isSyntacticallyValidModelId,
} from '@canopy/desktop-shared/types';
import { broadcastModelRegistryUpdated } from '../models/model-registry';
import { registerIpcHandler } from './register';
import {
  ModelHarnessOverridesUnreadableError,
  UnsupportedModelHarnessOverridesVersionError,
} from '@canopy/desktop-shared/node/model-harnesses';

export type ModelHarnessAssignmentErrorCode =
  | 'INVALID_REQUEST'
  | 'INVALID_HARNESS'
  | 'UNKNOWN_MODEL'
  | 'NOT_CONFIGURABLE'
  | 'UNAVAILABLE';

export class ModelHarnessAssignmentIpcError extends Error {
  constructor(
    readonly code: ModelHarnessAssignmentErrorCode,
    message: string,
  ) {
    super(`[MODEL_HARNESS_ASSIGNMENT_${code}] ${message}`);
    this.name = 'ModelHarnessAssignmentIpcError';
  }
}

/** Backend-owned policy/persistence adapter consumed by the IPC transport. */
export interface ModelHarnessAssignmentController {
  load(): Promise<ModelHarnessAssignmentSnapshot>;
  set(
    input: SetModelHarnessAssignmentInput,
  ): Promise<ModelHarnessAssignmentSnapshot>;
  reset(
    input: ResetModelHarnessAssignmentInput,
  ): Promise<ModelHarnessAssignmentSnapshot>;
}

const unavailableController: ModelHarnessAssignmentController = {
  load() {
    return Promise.resolve({ revision: 0, assignments: [] });
  },
  set() {
    return Promise.reject(
      new ModelHarnessAssignmentIpcError(
        'UNAVAILABLE',
        'The model harness assignment backend is not initialized',
      ),
    );
  },
  reset() {
    return Promise.reject(
      new ModelHarnessAssignmentIpcError(
        'UNAVAILABLE',
        'The model harness assignment backend is not initialized',
      ),
    );
  },
};

let controller: ModelHarnessAssignmentController = unavailableController;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function setModelHarnessAssignmentController(
  next: ModelHarnessAssignmentController | undefined,
): void {
  controller = next ?? unavailableController;
  if (!next) {
    initModelHarnessAssignments({ revision: 0, assignments: [] });
  }
}

function readModelId(value: unknown): string {
  if (!isRecord(value) || typeof value.modelId !== 'string' || !value.modelId) {
    throw new ModelHarnessAssignmentIpcError(
      'INVALID_REQUEST',
      'modelId must be a non-empty string',
    );
  }
  // Model registry keys legitimately include provider slashes, Ollama colons,
  // agent underscores, and tier brackets, so the generic `[a-z0-9-]` IPC id
  // validator is not the right domain contract. Validate the model-id grammar
  // directly and reject path syntax instead of weakening the boundary based
  // on whether an attacker-controlled value happens to exist in a catalog.
  if (
    !isSyntacticallyValidModelId(value.modelId) ||
    value.modelId.includes('..') ||
    value.modelId.includes('\\')
  ) {
    throw new ModelHarnessAssignmentIpcError(
      'INVALID_REQUEST',
      'modelId must be a valid model identifier without path traversal syntax',
    );
  }
  return value.modelId;
}

function readSetInput(value: unknown): SetModelHarnessAssignmentInput {
  const modelId = readModelId(value);
  if (!isRecord(value)) {
    throw new ModelHarnessAssignmentIpcError(
      'INVALID_REQUEST',
      'request must be an object',
    );
  }
  const harness = value.harness;
  if (
    harness !== 'claude' &&
    harness !== 'codex' &&
    harness !== 'cursor' &&
    harness !== 'opencode'
  ) {
    throw new ModelHarnessAssignmentIpcError(
      'INVALID_HARNESS',
      'harness must be "claude", "codex", "cursor", or "opencode"',
    );
  }
  return { modelId, harness };
}

async function withStableAssignmentError<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ModelHarnessAssignmentIpcError) throw error;
    if (error instanceof ModelHarnessPolicyError) {
      const code =
        error.code === 'UNKNOWN_MODEL'
          ? 'UNKNOWN_MODEL'
          : error.code === 'NOT_CONFIGURABLE'
            ? 'NOT_CONFIGURABLE'
            : error.code === 'INVALID_HARNESS'
              ? 'INVALID_HARNESS'
              : 'INVALID_REQUEST';
      throw new ModelHarnessAssignmentIpcError(code, error.message);
    }
    if (
      error instanceof UnsupportedModelHarnessOverridesVersionError ||
      error instanceof ModelHarnessOverridesUnreadableError
    ) {
      throw new ModelHarnessAssignmentIpcError('UNAVAILABLE', error.message);
    }
    throw new ModelHarnessAssignmentIpcError(
      'UNAVAILABLE',
      'The model harness assignment could not be saved',
    );
  }
}

export function registerModelHarnessAssignmentHandlers(): void {
  registerIpcHandler<[], ModelHarnessAssignmentSnapshot>(
    IPC_CHANNELS.harnessAssignmentsLoad,
    async (): Promise<ModelHarnessAssignmentSnapshot> => {
      const snapshot = await withStableAssignmentError(() => controller.load());
      initModelHarnessAssignments(snapshot);
      return snapshot;
    },
  );
  registerIpcHandler<[unknown], ModelHarnessAssignmentSnapshot>(
    IPC_CHANNELS.harnessAssignmentsSet,
    async (
      _event: IpcMainInvokeEvent,
      value: unknown,
    ): Promise<ModelHarnessAssignmentSnapshot> => {
      const input = readSetInput(value);
      const snapshot = await withStableAssignmentError(() =>
        controller.set(input),
      );
      initModelHarnessAssignments(snapshot);
      broadcastModelRegistryUpdated();
      return snapshot;
    },
  );
  registerIpcHandler<[unknown], ModelHarnessAssignmentSnapshot>(
    IPC_CHANNELS.harnessAssignmentsReset,
    async (
      _event: IpcMainInvokeEvent,
      value: unknown,
    ): Promise<ModelHarnessAssignmentSnapshot> => {
      const input = { modelId: readModelId(value) };
      const snapshot = await withStableAssignmentError(() =>
        controller.reset(input),
      );
      initModelHarnessAssignments(snapshot);
      broadcastModelRegistryUpdated();
      return snapshot;
    },
  );
}

/** Test-only cleanup matching Electron's one-handler-per-channel contract. */
export function removeModelHarnessAssignmentHandlers(): void {
  ipcMain.removeHandler(IPC_CHANNELS.harnessAssignmentsLoad);
  ipcMain.removeHandler(IPC_CHANNELS.harnessAssignmentsSet);
  ipcMain.removeHandler(IPC_CHANNELS.harnessAssignmentsReset);
}
