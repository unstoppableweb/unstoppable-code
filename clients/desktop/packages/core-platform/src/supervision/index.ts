import type {
  PlatformOperatingSystem,
  PlatformSupervisionServices,
} from '@canopy/core-runtime';
import { createChildServices } from './child';
import { createProcessIdentifier } from './identify';
import { createProcessInspector } from './inspect';
import { killProcessTree } from './kill-tree';
import { createProcessGroupLister } from './process-group-members';
import { createProcessTableReader } from './process-table';
import { NODE_SUPERVISION, type SupervisionOperations } from './shared';

export type { SupervisionOperations } from './shared';

export function createSupervisionServices(
  os: PlatformOperatingSystem,
  operations: Partial<SupervisionOperations> = {},
): PlatformSupervisionServices {
  const ops: SupervisionOperations = { ...NODE_SUPERVISION, ...operations };
  const inspectProcess = createProcessInspector(os, ops);
  const identifyProcess = createProcessIdentifier(os, ops, inspectProcess);
  const readProcessTable = createProcessTableReader(os);
  const listProcessGroup = createProcessGroupLister(
    os,
    ops,
    readProcessTable,
    identifyProcess,
  );
  const services: PlatformSupervisionServices = {
    ...createChildServices(os),
    killProcessTree: (request) => killProcessTree(os, request, ops),
    inspectProcess,
    identifyProcess,
    readProcessTable,
    ...(listProcessGroup && { listProcessGroup }),
  };
  return Object.freeze(services);
}
