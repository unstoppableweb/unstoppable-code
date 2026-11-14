/**
 * Field evidence for the chat automation migration (CAN-5479): one
 * `automation:chat_migration_end` event per run with candidates, so we can
 * see when every install has finished migrating and why an automation
 * didn't convert. Counts only: never an automation's name, prompt or ID, or
 * an error's text.
 */
import { createDesktopInstrumentationOperationKey } from '@canopy/desktop-instrumentation';
import {
  startDesktopOperation,
  succeedDesktopOperation,
} from '@canopy/desktop-instrumentation/electron/main';
import {
  getPostHogOperationCaptureState,
  subscribePostHogOperationCaptureChanges,
} from '../lib/posthog-operation-capture-gate';
import type {
  ChatAutomationMigrationResult,
  ChatAutomationMigrationFailure,
  ChatAutomationNativeReason,
} from './chat-automation-migration';

const OPERATION = 'canopy.chat_automation_migration';

/** Every key the event carries, each a non-negative count. */
export type ChatAutomationMigrationLabels = {
  readonly converted_count: number;
  readonly failed_count: number;
  readonly skipped_count: number;
  readonly failed_activity_running_count: number;
  readonly failed_not_found_count: number;
  readonly failed_not_a_chat_action_count: number;
  readonly failed_native_send_count: number;
  readonly failed_agent_route_count: number;
  readonly failed_agent_settings_count: number;
  readonly failed_target_requirement_count: number;
  readonly failed_pipeline_save_count: number;
  readonly failed_owner_not_recorded_count: number;
  readonly failed_settings_not_recorded_count: number;
  readonly failed_plugins_not_recorded_count: number;
  readonly failed_automations_write_count: number;
  readonly failed_unknown_count: number;
  readonly remaining_native_count: number;
  readonly remaining_native_send_count: number;
  readonly remaining_agent_route_count: number;
  readonly remaining_agent_settings_count: number;
  readonly remaining_target_requirement_count: number;
};

function sum(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

/** The labels a run sends: exactly the declared keys, each a count. */
export function chatAutomationMigrationLabels(
  result: ChatAutomationMigrationResult,
): ChatAutomationMigrationLabels {
  const failed: Readonly<Record<ChatAutomationMigrationFailure, number>> =
    result.failureCounts;
  const native: Readonly<Record<ChatAutomationNativeReason, number>> =
    result.nativeCounts;
  return {
    converted_count: result.converted.length,
    failed_count: result.failed.length,
    skipped_count: result.skipped.length,
    failed_activity_running_count: failed.activity_running,
    failed_not_found_count: failed.not_found,
    failed_not_a_chat_action_count: failed.not_a_chat_action,
    failed_native_send_count: failed.native_send,
    failed_agent_route_count: failed.agent_route,
    failed_agent_settings_count: failed.agent_settings,
    failed_target_requirement_count: failed.target_requirement,
    failed_pipeline_save_count: failed.pipeline_save,
    failed_owner_not_recorded_count: failed.owner_not_recorded,
    failed_settings_not_recorded_count: failed.settings_not_recorded,
    failed_plugins_not_recorded_count: failed.plugins_not_recorded,
    failed_automations_write_count: failed.automations_write,
    failed_unknown_count: failed.unknown,
    remaining_native_count: sum(native),
    remaining_native_send_count: native.native_send,
    remaining_agent_route_count: native.agent_route,
    remaining_agent_settings_count: native.agent_settings,
    remaining_target_requirement_count: native.target_requirement,
  };
}

function send(context: ChatAutomationMigrationLabels): void {
  try {
    const operationKey = createDesktopInstrumentationOperationKey(
      `${OPERATION}:${Date.now()}`,
    );
    startDesktopOperation(OPERATION, { operationKey, context });
    succeedDesktopOperation(OPERATION, { operationKey, context });
  } catch {
    // Telemetry never affects the migration.
  }
}

/** A run that finished before the capture gate's first decision. */
let pending: ChatAutomationMigrationLabels | undefined;
let unsubscribe: (() => void) | undefined;

function flushPending(): void {
  if (getPostHogOperationCaptureState() === undefined) return;
  const labels = pending;
  pending = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
  if (labels !== undefined && getPostHogOperationCaptureState()?.enabled)
    send(labels);
}

/**
 * Records a finished run, after its conversions. A run that ends before the
 * capture gate first decides is held until it does; one run a launch keeps
 * this to a single held event.
 */
export function recordChatAutomationMigration(
  result: ChatAutomationMigrationResult,
): void {
  try {
    const labels = chatAutomationMigrationLabels(result);
    const state = getPostHogOperationCaptureState();
    if (state === undefined) {
      pending = labels;
      unsubscribe ??= subscribePostHogOperationCaptureChanges(flushPending);
      return;
    }
    if (state.enabled) send(labels);
  } catch {
    // Telemetry never affects the migration.
  }
}

/** Test seam: forget a held run. */
export function resetChatAutomationMigrationTelemetryForTests(): void {
  pending = undefined;
  unsubscribe?.();
  unsubscribe = undefined;
}
