import {
  evaluateStorageWrite,
  STORAGE_OWNERSHIP,
  type StorageOwnershipRow,
} from '../../storage';

/**
 * The namespaces the daemon agent host writes, which the chat-rows switch-on
 * (CAN-7085) hands to the daemon in one commit. The legacy chat inputs stay
 * with the in-app host, and the usage-limit and resume-queue rows flip in a
 * later commit (CAN-4707, CAN-4708), so neither set is listed here.
 */
export const AGENT_HOST_NAMESPACES = Object.freeze([
  'chat_storage_v2',
  'chat_storage_manifests',
  'chat_search_index',
  'chat_plugins',
  'chat_import_staging',
  'workspace_derived',
  'delegation_records',
  'delegation_startup_stream_repair_checkpoint',
  'claude_process_pids',
  'codex_app_server_pids',
  'codex_reconstruction_seeds',
  'claude_worker_runtime',
  'delegation_transcript_spools',
] as const);

/**
 * Compiled ownership, never a runtime opt-in: true only when every agent host
 * namespace admits the daemon. Mixed ownership is not activation, and a row
 * missing from the table refuses, so today's compiled rows answer false.
 */
export function isAgentDaemonHostingRequired(
  rows: readonly StorageOwnershipRow[] = STORAGE_OWNERSHIP,
): boolean {
  return AGENT_HOST_NAMESPACES.every(
    (namespace) => evaluateStorageWrite(namespace, 'daemon', rows).allowed,
  );
}
