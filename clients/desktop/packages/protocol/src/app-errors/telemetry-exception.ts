import { getAppErrorDefinition } from './catalog';
import type { AppErrorRecord } from './handler';

/** Keep the catalog description and V8 stack frames. Raw detail can name private
 * work entries or contain caller prose that pattern redaction cannot identify. */
export function appErrorException(
  record: AppErrorRecord,
  frames: readonly string[],
): Error {
  const { code } = record.error;
  const error = new Error(getAppErrorDefinition(code).summary);
  error.name = code;
  // A non-empty catalog header keeps the SDK from substituting a launch stack.
  error.stack = [error.toString(), ...frames].join('\n');
  return error;
}
