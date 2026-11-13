'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import {
  useComposerMenuChannel,
  type ComposerMenuChannel,
} from '@canopy/ui-rich/editor';
import type { FileMentionOption } from '@canopy/ui-rich/types';
import {
  ComposerMenu,
  type ComposerMenuCommand,
  type ComposerMenuCommandOutcome,
  type ComposerMenuPick,
  type ComposerMenuProps,
} from './ComposerMenu';

export interface ComposerEditorMenuProps<
  TCommand extends ComposerMenuCommand,
> extends Omit<
  ComposerMenuProps<TCommand>,
  'controller' | 'commands' | 'searchFiles' | 'onSelectFile'
> {
  /** The channel the host's `ComposerEditor` publishes its session on. */
  channel: ComposerMenuChannel;
  /**
   * Loads the command catalog when a session lists commands. A session lists
   * the rows it loaded last at once and reloads them behind the list, so a
   * skill enabled elsewhere shows up. A new identity is a new catalog scope:
   * its catalog loads anew, and an open menu drops the old request.
   */
  loadCommands?: () => Promise<TCommand[]>;
  /**
   * Searches the files `@` can mention; the host debounces or caches. A new
   * identity is a new source (another checkout): earlier matches are dropped.
   */
  searchFiles?: (query: string) => Promise<FileMentionOption[]>;
  /** Files span several repositories: pills carry their repository name. */
  multiRepo?: boolean;
}

const NO_FILES: FileMentionOption[] = [];
const NO_COMMANDS: never[] = [];

/**
 * {@link ComposerMenu} for a host whose editor runs the menu session in its
 * own chunk (`ComposerEditor`'s `composerMenu`): it follows the session over
 * the channel, loads the host's command catalog and file matches as the
 * session asks for them, and inserts picked files through the session.
 * Until the editor publishes a session, the `+` opens the menu on its own.
 */
export function ComposerEditorMenu<TCommand extends ComposerMenuCommand>({
  channel,
  loadCommands,
  searchFiles,
  multiRepo = false,
  includeCommandsInAddMenu = false,
  isRefreshing = false,
  onSelectCommand,
  ...props
}: ComposerEditorMenuProps<TCommand>): JSX.Element {
  const controller = useComposerMenuChannel(channel);
  const open = controller?.open ?? false;
  const variant = controller?.variant ?? 'add';
  const query = controller?.query ?? '';

  // The session's rows render after its own commit, so the highlight is
  // resolved here once they are in the document: a new query, variant or
  // session starts on the first row, and otherwise follows the rows.
  const highlightKey = open ? `${variant}:${query}` : null;
  const highlightedForRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const reset = highlightedForRef.current !== highlightKey;
    highlightedForRef.current = highlightKey;
    if (highlightKey !== null) controller?.syncActiveRow(reset);
  });

  const commandsActive =
    open && (variant === 'commands' || includeCommandsInAddMenu);
  // The catalog stays loaded for its loader (the host's catalog scope)
  // across sessions, so reopening `/` lists it at once instead of
  // refetching it behind an empty frame. `stale` marks a catalog to load
  // again (behind its rows) when the next session lists it: a session
  // closed, a load failed, or a pick enabled a command.
  const [catalog, setCatalog] = useState<{
    loader: () => Promise<TCommand[]>;
    commands: TCommand[];
    stale: boolean;
  } | null>(null);
  // The load effect reads the catalog without re-running for it: a failed
  // load must wait for the next session, not retry at once.
  const catalogRef = useRef(catalog);
  useLayoutEffect(() => {
    catalogRef.current = catalog;
  }, [catalog]);
  const [loadingFor, setLoadingFor] = useState<
    (() => Promise<TCommand[]>) | null
  >(null);
  const catalogCurrent =
    loadCommands !== undefined && catalog?.loader === loadCommands;
  const commands = catalogCurrent ? catalog.commands : NO_COMMANDS;
  // A closed session leaves the catalog to load again when the next one
  // lists it (a skill enabled elsewhere meanwhile shows up), while that
  // session lists the cached rows at once.
  useEffect(() => {
    if (commandsActive) return;
    setCatalog((current) =>
      current === null || current.stale ? current : { ...current, stale: true },
    );
  }, [commandsActive]);
  useEffect(() => {
    if (!commandsActive || !loadCommands) return undefined;
    const cached = catalogRef.current;
    if (cached?.loader === loadCommands && !cached.stale) return undefined;
    let cancelled = false;
    setLoadingFor(() => loadCommands);
    loadCommands()
      .then((next) => {
        if (!cancelled)
          setCatalog({ loader: loadCommands, commands: next, stale: false });
      })
      // A failed load keeps what the scope listed before (nothing, the
      // first time): the menu says nothing matched, and the next session
      // loads again.
      .catch(() => {
        if (cancelled) return;
        setCatalog((current) => ({
          loader: loadCommands,
          commands: current?.loader === loadCommands ? current.commands : [],
          stale: true,
        }));
      })
      .finally(() => {
        if (!cancelled) setLoadingFor(null);
      });
    return (): void => {
      cancelled = true;
      setLoadingFor(null);
    };
  }, [commandsActive, loadCommands]);
  // Loading from the first frame a session lists a catalog it has not
  // loaded, rather than after an effect: no frame says nothing matched. A
  // reload behind cached rows shows no loading state.
  const commandsLoading =
    loadCommands !== undefined &&
    (!catalogCurrent ||
      (loadingFor === loadCommands && catalog.commands.length === 0));

  const handleSelectCommand = useMemo(() => {
    if (!onSelectCommand) return undefined;
    return (
      command: TCommand,
      pick: ComposerMenuPick,
    ): void | Promise<ComposerMenuCommandOutcome> => {
      const result = onSelectCommand(command, pick);
      if (!(result instanceof Promise)) return result;
      // A command enabled by the pick is listed differently now: the next
      // session reloads the catalog.
      return result.then((outcome) => {
        if (outcome === 'done' || outcome === 'skipped')
          setCatalog((current) =>
            current === null ? null : { ...current, stale: true },
          );
        return outcome;
      });
    };
  }, [onSelectCommand]);

  const filesActive = open && variant === 'add' && searchFiles !== undefined;
  // Matches belong to the source that returned them: another checkout's
  // matches for the same query are never listed (or inserted).
  const [fileResults, setFileResults] = useState<{
    source: (query: string) => Promise<FileMentionOption[]>;
    query: string;
    files: FileMentionOption[];
  } | null>(null);
  const [fileQueryInFlight, setFileQueryInFlight] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!filesActive || !searchFiles) return undefined;
    let cancelled = false;
    setFileQueryInFlight(query);
    searchFiles(query)
      .then((files) => {
        if (!cancelled) setFileResults({ source: searchFiles, query, files });
      })
      .catch(() => {
        if (!cancelled)
          setFileResults({ source: searchFiles, query, files: NO_FILES });
      })
      .finally(() => {
        if (!cancelled) setFileQueryInFlight(null);
      });
    return (): void => {
      cancelled = true;
    };
  }, [filesActive, searchFiles, query]);
  // The menu searches synchronously: it lists the matches the host's
  // current source returned for the query it shows, and nothing while that
  // query is in flight.
  const searchLoadedFiles = useCallback(
    (searched: string): FileMentionOption[] =>
      fileResults !== null &&
      fileResults.source === searchFiles &&
      fileResults.query === searched
        ? fileResults.files
        : NO_FILES,
    [fileResults, searchFiles],
  );

  const selectFile = useCallback(
    (file: FileMentionOption): void => {
      // Above one repository the pill carries the file's repository name.
      channel.getSnapshot()?.insertFile(file, multiRepo ? 2 : 1);
    },
    [channel, multiRepo],
  );

  return (
    <ComposerMenu<TCommand>
      {...props}
      {...(controller === null ? {} : { controller })}
      includeCommandsInAddMenu={includeCommandsInAddMenu}
      commands={commands}
      {...(handleSelectCommand === undefined
        ? {}
        : { onSelectCommand: handleSelectCommand })}
      {...(searchFiles === undefined
        ? {}
        : { searchFiles: searchLoadedFiles, onSelectFile: selectFile })}
      multiRepo={multiRepo}
      isRefreshing={
        isRefreshing ||
        (commandsActive && commandsLoading) ||
        (filesActive && fileQueryInFlight !== null)
      }
    />
  );
}
