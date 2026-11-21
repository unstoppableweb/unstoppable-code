import {
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
} from '../../definitions';
import {
  CanopyErrorPayloadSchema,
  CanopyKeyedRetryDirectiveSchema,
  CanopyQueryRetryDirectiveSchema,
} from '../../errors';
import {
  CoreFeedbackSubmitParamsSchema,
  CoreFeedbackSubmitResultSchema,
  CoreFeedbackTurnDeleteParamsSchema,
  CoreFeedbackTurnDeleteResultSchema,
  CoreFeedbackTurnListParamsSchema,
  CoreFeedbackTurnListResultSchema,
  CoreFeedbackTurnRateParamsSchema,
  CoreFeedbackTurnRateResultSchema,
  CoreFeedbackTurnUpdateParamsSchema,
  CoreFeedbackTurnUpdateResultSchema,
} from './schemas';

export const FEEDBACK_GRANTS = {
  read: 'core.feedback.read',
  write: 'core.feedback.write',
} as const;

// Standard error kinds only: no typed code crosses this contract.
const InherentErrorSchema = CanopyErrorPayloadSchema.omit({
  code: true,
}).extend({ retry: CanopyQueryRetryDirectiveSchema });
const KeyedErrorSchema = CanopyErrorPayloadSchema.omit({ code: true }).extend({
  retry: CanopyKeyedRetryDirectiveSchema,
});

const feedback = {
  plane: 'core',
  domain: 'feedback',
  version: 1,
  placement: 'core-only',
} as const;

// The shared registries leave these out: the desktop dispatcher composes them
// once CAN-4171 B3 serves them, and the web core joins in a later PR.
export const CORE_FEEDBACK_INSTRUCTION_DEFINITIONS =
  defineCanopyInstructionRegistry('core', {
    'core.feedback.turn.rate': defineCanopyInstruction({
      ...feedback,
      params: CoreFeedbackTurnRateParamsSchema,
      result: CoreFeedbackTurnRateResultSchema,
      error: InherentErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [FEEDBACK_GRANTS.write],
    }),
    'core.feedback.turn.update': defineCanopyInstruction({
      ...feedback,
      params: CoreFeedbackTurnUpdateParamsSchema,
      result: CoreFeedbackTurnUpdateResultSchema,
      error: InherentErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [FEEDBACK_GRANTS.write],
    }),
    'core.feedback.turn.delete': defineCanopyInstruction({
      ...feedback,
      params: CoreFeedbackTurnDeleteParamsSchema,
      result: CoreFeedbackTurnDeleteResultSchema,
      error: InherentErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [FEEDBACK_GRANTS.write],
    }),
    'core.feedback.submit': defineCanopyInstruction({
      ...feedback,
      params: CoreFeedbackSubmitParamsSchema,
      result: CoreFeedbackSubmitResultSchema,
      error: KeyedErrorSchema,
      idempotency: 'keyed',
      requiredGrants: [FEEDBACK_GRANTS.write],
    }),
  });

export const CORE_FEEDBACK_QUERY_DEFINITIONS = defineCanopyQueryRegistry(
  'core',
  {
    'core.feedback.turn.list': defineCanopyQuery({
      ...feedback,
      params: CoreFeedbackTurnListParamsSchema,
      result: CoreFeedbackTurnListResultSchema,
      error: InherentErrorSchema,
      idempotency: 'inherent',
      requiredGrants: [FEEDBACK_GRANTS.read],
    }),
  },
);
