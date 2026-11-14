import type { DesktopInstrumentationContextValue } from './types';

const OPERATIONS = new Set([
  'canopy.first_run_import_view',
  'canopy.first_run_import',
  'canopy.project_import',
  'canopy.invite_send',
  'canopy.invite_accept',
  'canopy.organization_create',
  'canopy.remote_pairing_start',
  'canopy.remote_pairing',
  'canopy.remote_control_device_add',
  'canopy.remote_control_pairing_fail',
  'canopy.remote_control_session_start',
  'canopy.remote_control_session_end',
  'canopy.remote_control_device_remove',
  // Every key is a `_count`: a non-negative safe integer or nothing.
  'canopy.chat_automation_migration',
]);
const ENUMS: Readonly<Record<string, readonly string[]>> = {
  claude_connection: ['connected', 'not_connected', 'unknown'],
  codex_connection: ['connected', 'not_connected', 'unknown'],
  scan_outcome: ['found', 'empty', 'failed', 'unknown'],
  source: ['first_run', 'import_modal'],
  modal_entry: ['invite', 'settings', 'app_advisor'],
  invite_type: ['teammate_share', 'organization'],
  recipient_kind: ['member', 'email'],
  share_audience: ['team', 'organization', 'public'],
  container_type: ['WORKTREE', 'COWORK', 'CLOUD_CHAT'],
  send_surface: ['share_dialog', 'invite_dialog', 'members_tab'],
  accept_surface: ['desktop_switcher', 'desktop_share_accept'],
  delivery: ['sent', 'resent', 'deferred-for-payment', 'email-suppressed'],
  creation_method: ['create', 'promote_personal'],
  pairing_kind: ['phone_code', 'computer_outgoing', 'computer_incoming'],
  pairing_entry: ['portal_modal', 'pair_computer_dialog', 'incoming_prompt'],
  peer_platform: ['darwin', 'win32', 'linux', 'unknown'],
  device_kind: ['desktop', 'mobile', 'browser', 'hosted'],
  pair_method: ['link', 'code'],
  failure_reason: [
    'denied',
    'expired',
    'proof_invalid',
    'proof_consumed',
    'persist_failed',
    'cancelled',
  ],
  end_reason: ['disconnected', 'revoked', 'expired', 'disabled', 'removed'],
};
const BOOLEANS = new Set([
  'claude_data_detected',
  'codex_data_detected',
  'credits_offered',
  'picked_folder',
  'invite_included',
  'is_first_accept_on_install',
  'is_additional_device',
  'is_delegated',
]);

/** Additional bounded-value validation for CAN-4635's exact key allowlists. */
export function validateAcquisitionContextValue(
  name: string,
  key: string,
  value: DesktopInstrumentationContextValue,
): boolean {
  if (!OPERATIONS.has(name)) return true;
  if (key === 'invite_ref' || key === 'grant_ref')
    return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value);
  if (BOOLEANS.has(key)) return typeof value === 'boolean';
  if (key.endsWith('_count') || key === 'install_age_days')
    return (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      (key !== 'install_age_days' || value <= 365)
    );
  if (key === 'outcome') {
    const allowed =
      name === 'canopy.first_run_import'
        ? ['imported', 'continued_empty', 'skipped']
        : name === 'canopy.project_import'
          ? ['imported', 'partial', 'none_imported', 'request_failed']
          : [
              'approved',
              'rejected',
              'declined',
              'failed',
              'cancelled',
              'expired',
              'timed_out',
            ];
    return typeof value === 'string' && allowed.includes(value);
  }
  const allowed = Object.prototype.hasOwnProperty.call(ENUMS, key)
    ? ENUMS[key]
    : undefined;
  return (
    allowed !== undefined &&
    typeof value === 'string' &&
    allowed.includes(value)
  );
}
