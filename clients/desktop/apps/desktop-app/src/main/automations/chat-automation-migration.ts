/**
 * The one-time migration of the remaining chat automations (CAN-5479): every
 * convertible chat automation nobody has edited since conversion on save
 * shipped (CAN-4551) is converted to a pipeline it owns, through the same
 * conversion as a person's save. Its ID, name, trigger, gate command, enabled
 * state and agent author stay, so it behaves the same to the person.
 *
 * Shipped dark: it runs only once {@link CHAT_AUTOMATION_MIGRATION_RELEASED}
 * is set. Release it only once the preconditions in
 * docs/planning/2026-10-29-can-4530-5c-and-7/deferred.md, item 1, hold.
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
  saveOwnedChatPipeline,
} from './chat-automation-conversion';
import type { AutomationsService } from './service';

/** The release lever; off until deferred.md's preconditions hold. */
export const CHAT_AUTOMATION_MIGRATION_RELEASED = false;

/** Whether the migration converts `activity`: a convertible chat automation. */
export function migratesChatAutomation(activity: ScheduledActivity): boolean {
  return convertsToOwnedChatPipeline(activity);
}

export interface ChatAutomationMigrationResult {
  /** IDs of the automations converted. */
  converted: string[];
  /** IDs of candidates kept native because their conversion failed. */
  failed: string[];
}

const NOT_MIGRATED = 'This automation is no longer migrated.';

/**
 * Converts every automation {@link migratesChatAutomation} accepts, one queued
 * write each. The automation is checked again inside the write, so an edit
 * since the list wins. A run in progress refuses its conversion, which the
 * next startup retries.
 */
export async function migrateChatAutomations(
  service: AutomationsService,
): Promise<ChatAutomationMigrationResult> {
  const result: ChatAutomationMigrationResult = { converted: [], failed: [] };
  const candidates = (
    await service.listActivitiesForChatAutomationMigration()
  ).filter(migratesChatAutomation);
  for (const { id } of candidates) {
    const converted = await service.replaceWithOwnedPipeline(
      id,
      async (fresh) => {
        if (!migratesChatAutomation(fresh)) throw new Error(NOT_MIGRATED);
        return saveOwnedChatPipeline(fresh);
      },
    );
    if (converted.ok) result.converted.push(id);
    else if (converted.error !== NOT_MIGRATED) result.failed.push(id);
  }
  if (candidates.length > 0)
    logMainProcessInfo('Migrated chat automations to workflows', {
      operation: 'migrate-chat-automations',
      converted: result.converted.length,
      failed: result.failed.length,
    });
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
