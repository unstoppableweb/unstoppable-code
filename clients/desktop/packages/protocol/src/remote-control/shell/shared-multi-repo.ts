import { z } from 'zod';
import {
  SharedMultiRepoCreateCommandSchema,
  PrepareSharedMultiRepoParamsSchema,
  SharedMultiRepoCreationStatusSchema,
} from '../../canopy-core/core/workspace/shared-multi-repo';

export const REMOTE_CONTROL_CAPABILITY_SHARED_MULTI_REPO =
  'org-shared-multi-repo-setup-v1';
/** Browser command results must be records, including empty recovery lists. */
export const RemoteControlSharedMultiRepoCreationsResultSchema = z.strictObject(
  {
    version: z.literal(1),
    creations: z.array(SharedMultiRepoCreationStatusSchema),
  },
);
const identity = {
  version: z.literal(1),
  accountId: z.uuid(),
  deviceId: z.uuid(),
};
export const RemoteControlSharedMultiRepoCommandSchema = z.discriminatedUnion(
  'action',
  [
    z.strictObject({
      ...identity,
      action: z.literal('prepare'),
      params: PrepareSharedMultiRepoParamsSchema,
    }),
    z.strictObject({
      ...identity,
      action: z.literal('create'),
      params: SharedMultiRepoCreateCommandSchema,
    }),
    z.strictObject({
      ...identity,
      action: z.literal('getCreation'),
      creationKey: z.string().min(1).max(128),
    }),
    z.strictObject({
      ...identity,
      action: z.literal('listCreations'),
      limit: z.number().int().min(1).max(100).optional(),
    }),
    z.strictObject({
      ...identity,
      action: z.literal('startSetup'),
      organizationId: z.uuid(),
      projectId: z.uuid(),
    }),
    z.strictObject({
      ...identity,
      action: z.literal('cancelSetup'),
      organizationId: z.uuid(),
      projectId: z.uuid(),
    }),
    z.strictObject({
      ...identity,
      action: z.literal('setupProgress'),
      organizationId: z.uuid(),
      projectId: z.uuid(),
    }),
    z.strictObject({
      ...identity,
      action: z.literal('catalog'),
      organizationId: z.uuid(),
      offset: z.number().int().min(0).max(100000).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    }),
  ],
);
export type RemoteControlSharedMultiRepoCommand = z.output<
  typeof RemoteControlSharedMultiRepoCommandSchema
>;
