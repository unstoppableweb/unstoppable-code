import { Stack } from '@canopy/ui-shared/components';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { ProjectStartPage } from '@canopy/protocol/start-page';
import type { HomeDiscoveryTarget } from '@canopy/desktop-shared/types';
import {
  Picker,
  PickerOption,
  PickerOptionCheck,
  PickerOptionContent,
  PickerOptionLabel,
  Button,
  PickerTriggerChevron,
  SearchField,
  SettingsRowsRow,
  TextInput,
} from '@canopy/ui-shared';
import { searchFiles, type FileSearchResult } from '@/lib/fuzzySearch';
import {
  isHttpStartPageUrl,
  startPageLabel,
} from '@/lib/start-page/project-start-page';
import { Surface } from '@canopy/ui-shared/components';

export type StartPageSettingValue = ProjectStartPage | null | undefined;

interface StartPageSettingControlProps {
  workspaceId: string;
  target: HomeDiscoveryTarget;
  projectType: 'cowork' | 'single-repo' | 'multi-repo';
  value: StartPageSettingValue;
  onChange: (value: StartPageSettingValue) => void;
  onValidityChange?: (isValid: boolean) => void;
  allowUseTeamSetting?: boolean;
  /**
   * `card` frames the setting with its own title. `row` is a settings row,
   * label leading and the picker trailing, for a page that groups rows.
   */
  layout?: 'card' | 'row';
}

type Choice = 'team' | 'chat' | 'file' | 'url';

const CHOICE_LABELS: Record<Choice, string> = {
  team: 'Use team setting',
  chat: 'New chat (default)',
  file: 'A file…',
  url: 'A web page…',
};

function choiceFor(
  value: StartPageSettingValue,
  allowUseTeamSetting: boolean,
): Choice {
  if (value === undefined && allowUseTeamSetting) return 'team';
  if (!value) return 'chat';
  return value.kind;
}

/** One settings row in the `row` layout; a hairline card in a dialog of cards. */
function StartPageFrame({
  layout,
  children,
}: {
  readonly layout: StartPageSettingControlProps['layout'];
  readonly children: ReactNode;
}): JSX.Element {
  return layout === 'row' ? (
    <div className="flex flex-col" data-testid="start-page-setting">
      {children}
    </div>
  ) : (
    <Surface
      variant="outline"
      padding="default"
      data-testid="start-page-setting"
    >
      {children}
    </Surface>
  );
}

export function StartPageSettingControl({
  workspaceId,
  target,
  projectType,
  value,
  onChange,
  onValidityChange,
  allowUseTeamSetting = false,
  layout = 'card',
}: StartPageSettingControlProps): JSX.Element {
  const [choice, setChoice] = useState<Choice>(() =>
    choiceFor(value, allowUseTeamSetting),
  );
  const [query, setQuery] = useState('');
  const [repos, setRepos] = useState<
    Awaited<ReturnType<typeof window.api.homeFileIndex>>['repos']
  >([]);
  const [url, setUrl] = useState(value?.kind === 'url' ? value.url : '');
  const [loadFailed, setLoadFailed] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const choiceTriggerRef = useRef<HTMLButtonElement>(null);
  const choiceMenuId = useId();

  useEffect(() => {
    setChoice(choiceFor(value, allowUseTeamSetting));
    if (value?.kind === 'file') setQuery(value.path);
    if (value?.kind === 'url') setUrl(value.url);
    onValidityChange?.(true);
  }, [allowUseTeamSetting, onValidityChange, value]);

  useEffect(() => {
    if (choice !== 'file') return;
    let canceled = false;
    setLoadFailed(false);
    void window.api
      .homeFileIndex({ workspaceId, target })
      .then((response) => {
        if (!canceled) setRepos(response.repos);
      })
      .catch(() => {
        if (!canceled) setLoadFailed(true);
      });
    return (): void => {
      canceled = true;
    };
  }, [choice, target, workspaceId]);

  const files = useMemo(() => searchFiles(query, repos, 30), [query, repos]);
  const chooseFile = (file: FileSearchResult): void => {
    onChange({
      kind: 'file',
      path: file.relativePath,
      ...(projectType === 'multi-repo' ? { repoId: file.repoId } : {}),
    });
    setQuery(file.relativePath);
    onValidityChange?.(true);
  };

  const applyUrl = (): void => {
    const trimmed = url.trim();
    if (isHttpStartPageUrl(trimmed)) {
      onChange({ kind: 'url', url: trimmed });
      onValidityChange?.(true);
    } else {
      onValidityChange?.(false);
    }
  };

  const selectedFileExists =
    value?.kind !== 'file' ||
    repos.length === 0 ||
    repos.some((repo) =>
      repo.files.some(
        (file) =>
          file.relativePath === value.path &&
          (value.repoId === undefined || repo.repoId === value.repoId),
      ),
    );

  const choose = (next: Choice): void => {
    setChoice(next);
    setChoiceOpen(false);
    if (next === 'team') {
      onChange(undefined);
      onValidityChange?.(true);
    } else if (next === 'chat') {
      onChange(null);
      onValidityChange?.(true);
    } else if (next === 'file') {
      setQuery(value?.kind === 'file' ? value.path : '');
      onValidityChange?.(value?.kind === 'file');
    } else {
      setUrl(value?.kind === 'url' ? value.url : '');
      onValidityChange?.(value?.kind === 'url');
    }
  };

  const choices: Choice[] = allowUseTeamSetting
    ? ['team', 'chat', 'file', 'url']
    : ['chat', 'file', 'url'];

  return (
    <StartPageFrame layout={layout}>
      {/* One settings row in both layouts: the label and its explanation
          leading, the 144px dropdown trailing. The card frames that row for
          a dialog of cards. */}
      <Stack gap="item">
        <SettingsRowsRow
          htmlFor="start-page-choice"
          label={layout === 'row' ? 'Open on start' : 'Start page'}
          description={
            layout === 'row'
              ? 'The first tab in each new worktree.'
              : 'Choose what opens first in each new work area.'
          }
          control={
            <Button
              ref={choiceTriggerRef}
              id="start-page-choice"
              variant="secondary"
              size="compact"
              className="w-36"
              onClick={() => setChoiceOpen((open) => !open)}
              aria-haspopup="listbox"
              aria-expanded={choiceOpen}
              aria-controls={choiceOpen ? choiceMenuId : undefined}
              data-testid="start-page-choice-trigger"
            >
              <span className="min-w-0 flex-1 truncate text-left">
                {CHOICE_LABELS[choice]}
              </span>
              <PickerTriggerChevron open={choiceOpen} variant="capsule" />
            </Button>
          }
        />
        <Picker
          id={choiceMenuId}
          open={choiceOpen}
          onOpenChange={setChoiceOpen}
          anchorRef={choiceTriggerRef}
          placement="bottom-left"
          interaction="listbox"
          role="listbox"
          aria-label="Start page choice"
          data-testid="start-page-choice-menu"
        >
          {choices.map((option) => (
            <PickerOption
              key={option}
              role="option"
              aria-selected={choice === option}
              selected={choice === option}
              onClick={() => choose(option)}
              data-testid={`start-page-choice-${option}`}
            >
              <PickerOptionContent>
                <PickerOptionLabel>{CHOICE_LABELS[option]}</PickerOptionLabel>
              </PickerOptionContent>
              <PickerOptionCheck selected={choice === option} />
            </PickerOption>
          ))}
        </Picker>

        {choice === 'file' && (
          <div className="flex flex-col gap-1.5">
            <SearchField
              size="sm"
              aria-label="Find a start page file"
              value={query}
              onValueChange={(next) => {
                setQuery(next);
                onValidityChange?.(
                  value?.kind === 'file' && next === value.path,
                );
              }}
              placeholder="Find a file"
            />
            {files.length > 0 && (
              <Surface variant="outline" className="overflow-hidden">
                <div className="max-h-44 overflow-y-auto p-1">
                  {files.map((file) => (
                    <PickerOption
                      key={`${file.repoId}:${file.relativePath}`}
                      onClick={() => chooseFile(file)}
                    >
                      <PickerOptionContent>
                        <PickerOptionLabel>
                          {projectType === 'multi-repo'
                            ? `${file.repoName} / ${file.relativePath}`
                            : file.relativePath}
                        </PickerOptionLabel>
                      </PickerOptionContent>
                    </PickerOption>
                  ))}
                </div>
              </Surface>
            )}
            {(loadFailed || !selectedFileExists) && (
              <p className="text-xs fg-warning">File not found</p>
            )}
          </div>
        )}

        {choice === 'url' && (
          <div className="flex items-center gap-2">
            <TextInput
              density="settings"
              aria-label="Start page URL"
              value={url}
              onChange={(event) => {
                setUrl(event.target.value);
                onValidityChange?.(
                  value?.kind === 'url' &&
                    event.target.value.trim() === value.url,
                );
              }}
              onBlur={applyUrl}
              placeholder="https://example.com"
              className="min-w-0 flex-1"
            />
            <Button
              size="compact"
              variant="secondary"
              disabled={!isHttpStartPageUrl(url)}
              onClick={applyUrl}
            >
              Use
            </Button>
          </div>
        )}
      </Stack>
      {value && (
        <p className="truncate text-xs fg-secondary">
          Opens to: {startPageLabel(value)}
        </p>
      )}
    </StartPageFrame>
  );
}
