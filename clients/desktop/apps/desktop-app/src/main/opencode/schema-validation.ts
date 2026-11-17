import { join } from 'node:path';
import {
  createMcpSchemaInputClassifier,
  createOpenCodeSchemaValidator,
} from '@canopy/desktop-shared/node/opencode/schema-validation';

const workerPath = join(__dirname, 'opencode-schema-validation-worker.js');

/** Shared by interactive and delegated permission checks; no main-thread fallback. */
export const validateOpenCodeMcpSchema =
  createOpenCodeSchemaValidator(workerPath);

/**
 * The same bundled worker for hosts that must tell an unenforceable schema
 * from invalid arguments (Antigravity selected MCP). Each call returns an
 * instance with its own queue, so one turn's calls never wait behind another's.
 */
export function createMcpToolArgumentClassifier(): ReturnType<
  typeof createMcpSchemaInputClassifier
> {
  // External servers often write PCRE-style escapes such as `\_`; patterns
  // still compile with the `u` flag.
  return createMcpSchemaInputClassifier(workerPath, { lenientPatterns: true });
}
