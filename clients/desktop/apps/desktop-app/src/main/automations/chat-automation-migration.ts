/**
 * The one-time migration of the remaining chat automations (CAN-5479): every
 * convertible chat automation nobody has edited since conversion on save
 * shipped (CAN-4551) is converted to a pipeline it owns, through the same
 * conversion as a person's save. Its ID, name, trigger, gate command, enabled
 * state and agent author stay, so it behaves the same to the person.
 *
 * It runs at startup while {@link CHAT_AUTOMATION_MIGRATION_RELEASED} is set;
 * docs/planning/2026-10-29-can-4530-5c-and-7/deferred.md, item 1, records
 * the release.
 *
 * Shared, public and curated installs convert too: conversion keeps the
 * automation, and with it the install's context and receipt checks. An
 * automation that can't convert, or whose conversion fails, keeps running
 * natively; the next startup tries it again.
 */
import type { ScheduledActivity } from '@canopy/desktop-shared/types';
import {
  logMainProcessError,
  logMainProcessInfo,
} from '../lib/main-process-logging';
import {
  convertsToOwnedChatPipeline,
  OwnedChatConversionError,
  ownedChatConversionRefusal,
  saveOwnedChatPipeline,
  type OwnedChatConversionFailure,
} from './chat-automation-conversion';
import { recordChatAutomationMigration } from './chat-automation-migration-telemetry';
import type {
  AutomationsService,
  OwnedPipelineReplaceFailure,
} from './service';

/** The release lever; setting it false stops the migration on startup. */
export const CHAT_AUTOMATION_MIGRATION_RELEASED = true;

/** Whether the migration converts `activity`: a convertible chat automation. */
export function migratesChatAutomation(activity: ScheduledActivity): boolean {
  return convertsToOwnedChatPipeline(activity);
}

/** Why a candidate's conversion failed, as a fixed code (CAN-5479). */
export type ChatAutomationMigrationFailure =
  | OwnedChatConversionFailure
  /** A run in progress refused it; the next startup retries. */
  | 'activity_running'
  /** It was deleted since the list was read. */
  | 'not_found'
  /** The automations file could not be written; the pipeline rolled back. */
  | 'automations_write'
  /** Anything else the conversion threw. */
  | 'unknown';

/**
 * Why a chat automation stays native by design: not a candidate, so the
 * expected remaining-native population. Not-a-chat-action automations are
 * not chat automations and aren't counted.
 */
export type ChatAutomationNativeReason =
  | 'native_send'
  | 'agent_route'
  | 'agent_settings'
  | 'target_requirement';

export interface ChatAutomationMigrationResult {
  /** IDs of the automations converted. */
  converted: string[];
  /** IDs of candidates kept native because their conversion failed. */
  failed: string[];
  /** IDs of candidates an edit since the list took out of the migration. */
  skipped: string[];
  /** How many of `failed` failed for each reason. */
  failureCounts: Record<ChatAutomationMigrationFailure, number>;
  /** The chat automations that stay native by design, by reason. */
  nativeCounts: Record<ChatAutomationNativeReason, number>;
}

/** The candidate changed since the list was read: a skip, not a failure. */
class ChatAutomationNotMigratedError extends Error {
  constructor() {
    super('This automation is no longer migrated.');
    this.name = 'ChatAutomationNotMigratedError';
  }
}

function emptyFailureCounts(): Record<ChatAutomationMigrationFailure, number> {
  return {
    activity_running: 0,
    not_found: 0,
    not_a_chat_action: 0,
    native_send: 0,
    agent_route: 0,
    agent_settings: 0,
    target_requirement: 0,
    pipeline_save: 0,
    owner_not_recorded: 0,
    settings_not_recorded: 0,
    plugins_not_recorded: 0,
    automations_write: 0,
    unknown: 0,
  };
}

/**
 * The chat automations in `activities` that stay native by design, by
 * reason, from the list the migration already read.
 */
function nativeCounts(
  activities: readonly ScheduledActivity[],
): Record<ChatAutomationNativeReason, number> {
  const counts: Record<ChatAutomationNativeReason, number> = {
    native_send: 0,
    agent_route: 0,
    agent_settings: 0,
    target_requirement: 0,
  };
  for (const activity of activities) {
    const refusal = ownedChatConversionRefusal(activity);
    if (refusal !== undefined && refusal !== 'not_a_chat_action')
      counts[refusal] += 1;
  }
  return counts;
}

/** Where a failed conversion stopped, as a skip or a fixed failure code. */
function failureReason(
  failure: OwnedPipelineReplaceFailure,
): ChatAutomationMigrationFailure | 'skipped' {
  switch (failure.stage) {
    case 'not_found':
    case 'activity_running':
    case 'automations_write':
      return failure.stage;
    case 'save':
      if (failure.cause instanceof ChatAutomationNotMigratedError)
        return 'skipped';
      return failure.cause instanceof OwnedChatConversionError
        ? failure.cause.reason
        : 'unknown';
  }
}

const FAILURE_REASONS: readonly ChatAutomationMigrationFailure[] = [
  'activity_running',
  'not_found',
  'not_a_chat_action',
  'native_send',
  'agent_route',
  'agent_settings',
  'target_requirement',
  'pipeline_save',
  'owner_not_recorded',
  'settings_not_recorded',
  'plugins_not_recorded',
  'automations_write',
  'unknown',
];

/** The reasons that failed at least once, for the local log. */
function failedReasons(
  counts: Record<ChatAutomationMigrationFailure, number>,
): Partial<Record<ChatAutomationMigrationFailure, number>> {
  const reasons: Partial<Record<ChatAutomationMigrationFailure, number>> = {};
  for (const reason of FAILURE_REASONS)
    if (counts[reason] > 0) reasons[reason] = counts[reason];
  return reasons;
}

/**
 * Converts every automation {@link migratesChatAutomation} accepts, one queued
 * write each. The automation is checked again inside the write, so an edit
 * since the list wins. A run in progress refuses its conversion, which the
 * next startup retries. A run with candidates is logged and recorded as one
 * `automation:chat_migration_end` event, after its conversions.
 */
export async function migrateChatAutomations(
  service: AutomationsService,
): Promise<ChatAutomationMigrationResult> {
  const activities = await service.listActivitiesForChatAutomationMigration();
  const result: ChatAutomationMigrationResult = {
    converted: [],
    failed: [],
    skipped: [],
    failureCounts: emptyFailureCounts(),
    nativeCounts: nativeCounts(activities),
  };
  const candidates = activities.filter(migratesChatAutomation);
  for (const { id } of candidates) {
    const converted = await service.replaceWithOwnedPipeline(
      id,
      async (fresh) => {
        if (!migratesChatAutomation(fresh))
          throw new ChatAutomationNotMigratedError();
        return saveOwnedChatPipeline(fresh);
      },
    );
    if (converted.ok) {
      result.converted.push(id);
      continue;
    }
    const reason = failureReason(converted.failure);
    if (reason === 'skipped') {
      result.skipped.push(id);
      continue;
    }
    result.failed.push(id);
    result.failureCounts[reason] += 1;
  }
  if (candidates.length > 0) {
    logMainProcessInfo('Migrated chat automations to workflows', {
      operation: 'migrate-chat-automations',
      converted: result.converted.length,
      failed: result.failed.length,
      skipped: result.skipped.length,
      failedReasons: failedReasons(result.failureCounts),
    });
    recordChatAutomationMigration(result);
  }
  return result;
}

export interface ChatAutomationMigrationTrigger {
  service: AutomationsService;
  released?: boolean;
  migrate?: (
    service: AutomationsService,
  ) => Promise<ChatAutomationMigrationResult>;
}

/** Runs the migration once, in the background, when it is released. */
export function startChatAutomationMigration({
  service,
  released = CHAT_AUTOMATION_MIGRATION_RELEASED,
  migrate = migrateChatAutomations,
}: ChatAutomationMigrationTrigger): void {
  if (!released) return;
  void migrate(service).catch((error: unknown) =>
    logMainProcessError('Failed to migrate chat automations', error),
  );
}
