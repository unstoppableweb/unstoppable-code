import type {
  PlatformOperatingSystem,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import { createChildServices } from './child';
import { createProcessIdentifier } from './identify';
import { createProcessInspector } from './inspect';
import { killProcessTree } from './kill-tree';
import { createProcessTableReader } from './process-table';
import { NODE_SUPERVISION, type SupervisionOperations } from './shared';

export type { SupervisionOperations } from './shared';

export function createSupervisionServices(
  os: PlatformOperatingSystem,
  operations: Partial<SupervisionOperations> = {},
): PlatformSupervisionServices {
  const ops: SupervisionOperations = { ...NODE_SUPERVISION, ...operations };
  const inspectProcess = createProcessInspector(os, ops);
  const services: PlatformSupervisionServices = {
    ...createChildServices(os),
    killProcessTree: (request) => killProcessTree(os, request, ops),
    inspectProcess,
    identifyProcess: createProcessIdentifier(os, ops, inspectProcess),
    readProcessTable: createProcessTableReader(os),
  };
  return Object.freeze(services);
}
