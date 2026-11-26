'use client';

import { useRef, useState, type JSX } from 'react';
import { InfoIcon } from '../icons/InfoIcon';
import { Button } from '../primitives/Button';
import { Popover } from '../primitives/Popover';
import { Tooltip } from '../primitives/Tooltip';

const SCOPE_GUIDANCE = [
  'This list comes from your available skills, plugin marketplaces, collections, and configured MCP servers.',
  'Source shows where each item comes from.',
  'Selections apply to every chat in this project, including existing chats, from their next message.',
  'A chat can still turn a default off.',
  'Selections do not install plugins.',
  'Chats can also inherit global defaults and account-managed connectors.',
] as const;

const SCOPE_HELP_TITLE = 'How project defaults work';
const SCOPE_SUMMARY =
  'Defaults for every chat in this project. A chat can still turn one off.';

/**
 * Catalog provenance and scope shared by desktop project settings surfaces:
 * one line, with the full guidance in a popover the info button opens.
 */
export function PluginSelectionScopeHelp(): JSX.Element {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  return (
    <div
      data-testid="workspace-plugin-scope-help"
      className="flex min-w-0 items-center gap-1 text-xs fg-secondary"
    >
      <span className="min-w-0 truncate" title={SCOPE_SUMMARY}>
        {SCOPE_SUMMARY}
      </span>
      <Tooltip label={SCOPE_HELP_TITLE} suppressed={open}>
        <Button
          ref={buttonRef}
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={SCOPE_HELP_TITLE}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((current) => !current)}
          className="-my-1.5"
        >
          <InfoIcon aria-hidden="true" />
        </Button>
      </Tooltip>
      <Popover
        open={open}
        onOpenChange={setOpen}
        anchorRef={buttonRef}
        aria-label={SCOPE_HELP_TITLE}
        data-testid="workspace-plugin-scope-help-details"
      >
        <div className="flex flex-col gap-1 text-xs">
          <p className="font-medium fg-primary">{SCOPE_HELP_TITLE}</p>
          <ul className="list-disc flex flex-col gap-0.5 pl-4 fg-secondary">
            {SCOPE_GUIDANCE.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </Popover>
    </div>
  );
}
