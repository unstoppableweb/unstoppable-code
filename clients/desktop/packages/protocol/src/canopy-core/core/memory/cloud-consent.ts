import { z } from 'zod';
import {
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
} from '../../definitions';
import {
  inherentOperationErrorSchema,
  keyedOperationErrorSchema,
} from '../shared';

export const CloudMemoryProjectBindingSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({ kind: z.literal('tracked'), projectId: z.uuid() }),
]);

export const CloudMemoryConsentSchema = z.strictObject({
  revision: z.number().int().min(1),
  allowed: z.boolean(),
});
export type CloudMemoryConsent = z.output<typeof CloudMemoryConsentSchema>;

const BASE = {
  plane: 'core',
  domain: 'memory',
  version: 1,
  placement: 'core-only',
} as const;
// Web-core only. Do not compose into desktop or daemon definitions.
export const CORE_CLOUD_MEMORY_CONSENT_QUERIES = defineCanopyQueryRegistry(
  'core',
  {
    'core.memory.cloudConsent.get': defineCanopyQuery({
      ...BASE,
      requiredGrants: ['core.memory.consent'],
      idempotency: 'inherent',
      params: z.strictObject({}),
      result: CloudMemoryConsentSchema,
      error: inherentOperationErrorSchema(['core.memory.policyUnavailable']),
    }),
  },
);
export const CORE_CLOUD_MEMORY_CONSENT_INSTRUCTIONS =
  defineCanopyInstructionRegistry('core', {
    'core.memory.cloudConsent.set': defineCanopyInstruction({
      ...BASE,
      requiredGrants: ['core.memory.consent'],
      idempotency: 'keyed',
      params: z.strictObject({
        expectedRevision: z.number().int().min(1),
        allowed: z.boolean(),
      }),
      result: CloudMemoryConsentSchema,
      error: keyedOperationErrorSchema([
        'core.memory.consent.revisionConflict',
      ]),
    }),
  });
