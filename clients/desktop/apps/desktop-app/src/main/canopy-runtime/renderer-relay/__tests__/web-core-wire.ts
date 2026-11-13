/**
 * The web core wire as the desktop E2E harness's fake web cores check it
 * (CAN-6342): the operations the desktop may send, each request as the wire
 * admits it, the web core's UUID rule, and the cloud run operations it
 * reports. The fixtures import them from here, beside the relay definitions,
 * because the harness loads protocol source only through modules under `src`:
 * a fixture that imported protocol source directly would load it as ESM while
 * this module loads it as CommonJS, and the lane that runs both would collect
 * no tests (CAN-6351).
 */
import {
  composeCanopyOperationEnvelopes,
  type CanopyInstructionDefinition,
  type CanopyQueryDefinition,
  type CanopyStreamDefinition,
} from '@canopy/protocol/canopy-core';
import type { ZodType } from 'zod';
import {
  WEB_CORE_HOST_DEFINITIONS,
  WEB_CORE_RELAY_DEFINITIONS,
} from '../web-core-relay-definitions';

export { CORE_PIPELINE_CLOUD_RUN_OPERATIONS } from '@canopy/protocol/canopy-core';
export { isUuid } from '@canopy/protocol/uuid';

type Definition =
  | CanopyQueryDefinition
  | CanopyInstructionDefinition
  | CanopyStreamDefinition;

/** What the renderer may call on the web core, and what main itself calls. */
export const WEB_CORE_DEFINITIONS: Readonly<Record<string, Definition>> = {
  ...WEB_CORE_RELAY_DEFINITIONS.queries,
  ...WEB_CORE_RELAY_DEFINITIONS.instructions,
  ...WEB_CORE_RELAY_DEFINITIONS.streams,
  ...WEB_CORE_HOST_DEFINITIONS.instructions,
};

const requests = new Map<string, ZodType>();

/**
 * An operation's request as the wire admits it: the definition's params,
 * with `_meta` (required when keyed) and `_execution` only where the
 * operation accepts host execution. Undefined for an operation the desktop
 * never sends.
 */
export function webCoreRequestSchema(method: string): ZodType | undefined {
  const definition = WEB_CORE_DEFINITIONS[method];
  if (definition === undefined) return undefined;
  let request = requests.get(method);
  if (request === undefined) {
    request = composeCanopyOperationEnvelopes(method, definition).request;
    requests.set(method, request);
  }
  return request;
}
