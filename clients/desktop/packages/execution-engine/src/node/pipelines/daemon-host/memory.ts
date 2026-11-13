import {
  createProcessTableReader,
  hostPlatformOperatingSystem,
} from '@canopy/core-platform';
import {
  ExecutionAccounting,
  type ExecutionAccountingLimits,
  type GenericResourceMetadata,
  type PlatformSupervisionServices,
} from '@canopy/core-runtime';
import type { PipelineHostMemoryBudget } from '@canopy/core-runtime/node/pipeline/host';
import type { ExecutionMemoryReading } from '../executor/types';

/*
 * A sized pipeline host's memory (CAN-6325). The host measures its own
 * process tree, which holds every step it runs, with the core execution
 * accounting (CAN-4135), against the budget its supervisor configured. On
 * Linux it also reads what the machine has available, which counts what
 * else shares a sandbox, such as a worktree's chats.
 */

/** How old a sample may be before a read takes another. */
export const PIPELINE_HOST_MEMORY_SAMPLE_MAX_AGE_MS = 1_000;

export interface PipelineHostMemoryReaderOptions {
  readonly budget: PipelineHostMemoryBudget;
  readonly readProcessTable?: PlatformSupervisionServices['readProcessTable'];
  /** What the machine has available; Linux's own by default, undefined elsewhere. */
  readonly availableMemory?: () => number | undefined;
  readonly rootPid?: number;
  readonly now?: () => number;
}

/** Linux reports available memory that counts its cgroup; macOS reports only free pages. */
function linuxAvailableMemory(): number | undefined {
  if (hostPlatformOperatingSystem() !== 'linux') return undefined;
  const available = process.availableMemory();
  // 0 is a full cgroup, not a missing reading.
  return Number.isFinite(available) && available >= 0 ? available : undefined;
}

/** Whether a configured budget is one a host can hold steps to. */
export function isPipelineHostMemoryBudget(
  value: unknown,
): value is PipelineHostMemoryBudget {
  if (typeof value !== 'object' || value === null) return false;
  const budgetBytes: unknown = Reflect.get(value, 'budgetBytes');
  const chatReserveBytes: unknown = Reflect.get(value, 'chatReserveBytes');
  return (
    typeof budgetBytes === 'number' &&
    Number.isSafeInteger(budgetBytes) &&
    budgetBytes > 0 &&
    (chatReserveBytes === undefined ||
      (typeof chatReserveBytes === 'number' &&
        Number.isSafeInteger(chatReserveBytes) &&
        chatReserveBytes >= 0 &&
        chatReserveBytes < budgetBytes))
  );
}

export function createPipelineHostMemoryReader(
  options: PipelineHostMemoryReaderOptions,
): () => Promise<ExecutionMemoryReading | undefined> {
  const now = options.now ?? Date.now;
  const { budgetBytes, chatReserveBytes } = options.budget;
  const availableMemory = options.availableMemory ?? linuxAvailableMemory;
  const accounting = new ExecutionAccounting<GenericResourceMetadata>({
    rootPid: options.rootPid ?? process.pid,
    readProcessTable:
      options.readProcessTable ??
      createProcessTableReader(hostPlatformOperatingSystem()),
    limits: (): ExecutionAccountingLimits => ({
      maxActive: {},
      memoryGuardEnabled: true,
      warningMemoryBytes: Math.floor(budgetBytes * 0.8),
      criticalMemoryBytes: budgetBytes,
    }),
    productName: 'Pipeline host',
    groupLabel: (): string => 'Pipeline host',
    executionIdOf: (): undefined => undefined,
    now,
  });
  let sampledAt = Number.NEGATIVE_INFINITY;

  return async (): Promise<ExecutionMemoryReading | undefined> => {
    if (now() - sampledAt >= PIPELINE_HOST_MEMORY_SAMPLE_MAX_AGE_MS) {
      try {
        await accounting.sample();
        sampledAt = now();
      } catch {
        // The process table failed; the machine's own reading may stand alone.
      }
    }
    const headroom = accounting.memoryHeadroom();
    const machine = availableMemory();
    if (headroom === undefined && machine === undefined) return undefined;
    return {
      availableBytes: Math.min(
        headroom?.availableBytes ?? Number.POSITIVE_INFINITY,
        machine ?? Number.POSITIVE_INFINITY,
      ),
      totalBytes: budgetBytes,
      sampledAt: headroom?.sampledAt ?? now(),
      ...(chatReserveBytes === undefined ? {} : { chatReserveBytes }),
    };
  };
}
