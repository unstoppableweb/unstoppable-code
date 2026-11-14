'use client';

import { memo, useCallback, useEffect, useId, useState, type JSX } from 'react';
import { useOptionalCanopyClient } from '@canopy/app-state';
import type {
  ClaudeModPluginDetailsTarget,
  ClaudeModsChatContext,
  ClaudeModsState,
} from '@canopy/protocol/claude-mods';
import {
  ClaudeModsSkippedNoticeFrame,
  ClaudeModsSkippedRow,
  CLAUDE_MODS_SKIPPED_COPY,
  ErrorBanner,
  isClaudeModsInlineAllowPluginId,
  NoticeButton,
  readClaudeModsSkippedMods,
  ToggleSwitchField,
  type ClaudeModsSkippedMod,
} from '@canopy/ui-shared/components';
import {
  claudeModAdmissionSwitchState,
  claudeModAdmissionUpdate,
} from './claudeModAdmissionModel';
import {
  CLAUDE_MODS_COPY,
  CLAUDE_MODS_UPDATE_ERROR_COPY,
} from './claudeModsCopy';
import { useClaudeMods } from './useClaudeMods';

export interface ClaudeModsSkippedNoticeViewProps {
  readonly mods: readonly ClaudeModsSkippedMod[];
  /** The chat whose launch skipped the Mods. */
  readonly context?: ClaudeModsChatContext;
  /** Opens a catalog plugin's details page. Without it, no plugin links. */
  readonly onOpenDetails?: (details: ClaudeModPluginDetailsTarget) => void;
  /** `composer` says what the next message's launch will skip. */
  readonly placement?: 'transcript' | 'composer';
  readonly onDismiss?: () => void;
}

interface SkippedModRowProps {
  readonly rowKey: string;
  readonly mod: ClaudeModsSkippedMod;
  readonly context: ClaudeModsChatContext | undefined;
  readonly onOpenDetails:
    | ((details: ClaudeModPluginDetailsTarget) => void)
    | undefined;
  /** Every row is allowed, so the notice title says it and rows don't. */
  readonly allAllowed: boolean;
  readonly onAllowedChange: (rowKey: string, allowed: boolean) => void;
}

/**
 * The plugin's current state when it says something the launch reason
 * doesn't: a reason already naming the same cause keeps one home for it.
 */
function currentStatusText(
  statusText: string | null,
  state: ClaudeModsState,
  reason: string,
): string | null {
  if (statusText === null) return null;
  if (state.modsDisabled && reason === 'kill-switch') return null;
  if (
    !state.modsDisabled &&
    state.authorityUnreadable &&
    reason === 'authority-unreadable'
  ) {
    return null;
  }
  if (
    !state.modsDisabled &&
    !state.authorityUnreadable &&
    state.plugin?.status === 'changed' &&
    reason === 'digest-changed'
  ) {
    return null;
  }
  return statusText;
}

/** Says a Mod the launch skipped is allowed now, so the next message loads it. */
function allowedNowText(state: ClaudeModsState): string | null {
  return !state.modsDisabled &&
    !state.authorityUnreadable &&
    state.plugin?.status === 'allowed'
    ? CLAUDE_MODS_SKIPPED_COPY.allowedNextMessage
    : null;
}

function SkippedModStatus({
  id,
  text,
}: {
  readonly id?: string;
  readonly text: string;
}): JSX.Element {
  return (
    <span id={id} data-testid="claude-mods-skipped-status" className="block">
      {text}
    </span>
  );
}

/** One skipped plugin with the controls its current state allows. */
function InteractiveSkippedModRow({
  rowKey,
  mod,
  context,
  onOpenDetails,
  allAllowed,
  onAllowedChange,
}: SkippedModRowProps): JSX.Element {
  const { state, pending, error, update } = useClaudeMods(
    mod.pluginId,
    context,
  );
  const generatedId = useId();
  const plugin = state?.enabled === true ? state.plugin : undefined;
  const allowedText = state && plugin ? allowedNowText(state) : null;
  const allowed = allowedText !== null;
  useEffect(() => {
    onAllowedChange(rowKey, allowed);
  }, [onAllowedChange, rowKey, allowed]);
  useEffect(
    () => (): void => onAllowedChange(rowKey, false),
    [onAllowedChange, rowKey],
  );
  if (!state || !plugin) {
    return <ClaudeModsSkippedRow pluginId={mod.pluginId} reason={mod.reason} />;
  }
  // An allowed row replaces the launch's reason: with the rest of the notice,
  // or on its own while another Mod is still off.
  const reasonOverride =
    allowedText !== null ? { reasonText: allAllowed ? null : allowedText } : {};

  if (!isClaudeModsInlineAllowPluginId(mod.pluginId)) {
    const details = plugin.details;
    return (
      <ClaudeModsSkippedRow
        pluginId={mod.pluginId}
        reason={mod.reason}
        {...reasonOverride}
        {...(details && onOpenDetails
          ? {
              actions: (
                <NoticeButton
                  variant="secondary"
                  data-testid="claude-mods-skipped-open-details"
                  onClick={(): void => onOpenDetails(details)}
                >
                  {CLAUDE_MODS_SKIPPED_COPY.openDetails}
                </NoticeButton>
              ),
            }
          : {})}
      />
    );
  }

  const switchId = `claude-mods-skipped-allow-${generatedId}`;
  const statusId = `claude-mods-skipped-status-${generatedId}`;
  const errorId = `claude-mods-skipped-error-${generatedId}`;
  const switchState = claudeModAdmissionSwitchState(state, plugin, pending);
  const statusText = currentStatusText(
    switchState.statusText,
    state,
    mod.reason,
  );
  const describedBy = [
    statusText !== null ? statusId : null,
    error ? errorId : null,
  ]
    .filter((id): id is string => id !== null)
    .join(' ');

  return (
    <ClaudeModsSkippedRow
      pluginId={mod.pluginId}
      reason={mod.reason}
      {...reasonOverride}
      actions={
        <ToggleSwitchField
          id={switchId}
          size="sm"
          caption={CLAUDE_MODS_COPY.admissionLabel}
          checked={switchState.checked}
          disabled={switchState.disabled}
          busy={pending}
          {...(describedBy !== '' ? { describedBy } : {})}
          dataTestId="claude-mods-skipped-allow-switch"
          onChange={(next): void => {
            const nextUpdate = claudeModAdmissionUpdate(plugin, next);
            if (nextUpdate) update(nextUpdate);
          }}
        />
      }
      {...(statusText !== null || error
        ? {
            detail: (
              <>
                {statusText !== null ? (
                  <SkippedModStatus id={statusId} text={statusText} />
                ) : null}
                {/* A failure in a tight spot is still an ErrorBanner. The
                    switch stays where it was, so it is the way to try again. */}
                {error ? (
                  <span id={errorId} className="block">
                    <ErrorBanner
                      errorSource="claude-mods-skipped-error"
                      className=""
                      testId="claude-mods-skipped-error"
                      error={CLAUDE_MODS_UPDATE_ERROR_COPY[error]}
                    />
                  </span>
                ) : null}
              </>
            ),
          }
        : {})}
    />
  );
}

/**
 * The skipped-Mod notice with its actions: "Open details" for a catalog
 * plugin, an inline "Allow in Claude chats" switch for a skills-folder or
 * synced plugin. Controls appear only once the client supports Mod admission
 * and the plugin's state says admission is on; the text renders everywhere,
 * including hosts with no client.
 */
function ClaudeModsSkippedNoticeViewComponent({
  mods,
  context,
  onOpenDetails,
  placement,
  onDismiss,
}: ClaudeModsSkippedNoticeViewProps): JSX.Element | null {
  const client = useOptionalCanopyClient();
  const interactive = client?.capabilities.claudeModAdmission === true;
  const [allowedKeys, setAllowedKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const onAllowedChange = useCallback(
    (rowKey: string, allowed: boolean): void => {
      setAllowedKeys((current) => {
        if (current.has(rowKey) === allowed) return current;
        const next = new Set(current);
        if (allowed) next.add(rowKey);
        else next.delete(rowKey);
        return next;
      });
    },
    [],
  );
  if (mods.length === 0) return null;
  // A launch lists a plugin once; the index keeps keys unique if a malformed
  // record repeats one.
  const keys = mods.map((mod, index) => `${mod.pluginId}:${index}`);
  const allAllowed = interactive && keys.every((key) => allowedKeys.has(key));
  return (
    <ClaudeModsSkippedNoticeFrame
      count={mods.length}
      allowed={allAllowed}
      {...(placement ? { placement } : {})}
      {...(onDismiss ? { onDismiss } : {})}
      {...(placement === 'composer'
        ? { dataTestId: 'claude-mods-composer-notice' }
        : {})}
    >
      {mods.map((mod, index) => {
        const key = keys[index] ?? `${mod.pluginId}:${index}`;
        return interactive ? (
          <InteractiveSkippedModRow
            key={key}
            rowKey={key}
            mod={mod}
            context={context}
            onOpenDetails={onOpenDetails}
            allAllowed={allAllowed}
            onAllowedChange={onAllowedChange}
          />
        ) : (
          <ClaudeModsSkippedRow
            key={key}
            pluginId={mod.pluginId}
            reason={mod.reason}
          />
        );
      })}
    </ClaudeModsSkippedNoticeFrame>
  );
}

export const ClaudeModsSkippedNoticeView = memo(
  ClaudeModsSkippedNoticeViewComponent,
);

export interface ClaudeModsSkippedPartProps {
  /** A Portal `mods_skipped` part's untyped data. */
  readonly data: unknown;
  readonly context?: ClaudeModsChatContext;
  readonly onOpenDetails?: (details: ClaudeModPluginDetailsTarget) => void;
}

/** The notice for a Portal `mods_skipped` part; nothing without its mods. */
export function ClaudeModsSkippedPart({
  data,
  context,
  onOpenDetails,
}: ClaudeModsSkippedPartProps): JSX.Element | null {
  const mods = readClaudeModsSkippedMods(data);
  if (mods.length === 0) return null;
  return (
    <ClaudeModsSkippedNoticeView
      mods={mods}
      {...(context !== undefined ? { context } : {})}
      {...(onOpenDetails !== undefined ? { onOpenDetails } : {})}
    />
  );
}
