import type {
  PlatformOperatingSystem,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import { createChildServices } from './child';
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
  const services: PlatformSupervisionServices = {
    ...createChildServices(os),
    killProcessTree: (request) => killProcessTree(os, request, ops),
    inspectProcess: createProcessInspector(os, ops),
    readProcessTable: createProcessTableReader(os),
  };
  return Object.freeze(services);
}
