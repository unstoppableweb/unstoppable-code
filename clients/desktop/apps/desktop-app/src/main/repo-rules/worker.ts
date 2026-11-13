import type { EditorSetupPresence } from '@canopy/protocol/repo-rules';
import type { RepoRulesCheckoutReader } from '@canopy/core-runtime/node/workspace/repo-rules';
import {
  discoverRules,
  readSessionRules,
  type RepoCheckout,
} from './discovery';
import { editorSetupPresence } from './presence';

/** Worker owns checkout access; core supplies authorized roots and policy. */
export interface RepoRulesWorkerPort extends RepoRulesCheckoutReader {
  presence(repos: RepoCheckout[]): Promise<EditorSetupPresence>;
}

/** Same-process binding. No transport, writer, or execution authority moves. */
export const repoRulesWorker: RepoRulesWorkerPort = {
  scan: discoverRules,
  readSession: readSessionRules,
  presence: editorSetupPresence,
};
