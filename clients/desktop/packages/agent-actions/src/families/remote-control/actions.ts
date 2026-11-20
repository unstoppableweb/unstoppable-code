import { z } from 'zod';

export const REMOTE_CONTROL_ACTION_TYPES = [
  'remote_control.open_dialog',
  'remote_control.close_dialog',
] as const;

export const remoteControlActionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('remote_control.open_dialog'),
  }),
  z.strictObject({
    type: z.literal('remote_control.close_dialog'),
  }),
]);

export type RemoteControlAction = z.output<typeof remoteControlActionSchema>;
