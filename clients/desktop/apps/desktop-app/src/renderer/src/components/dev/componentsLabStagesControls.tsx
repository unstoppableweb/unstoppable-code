import type { JSX } from 'react';
import {
  Badge,
  Button,
  Chip,
  Fact,
  FactList,
  FormField,
  ListRow,
  SegmentedControl,
  SettingsRowsGroup,
  SettingsRowsRow,
  StatusGlyph,
  TabBar,
  TextArea,
  TextInput,
} from '@canopy/ui-shared/components';
import { ChatIcon, FileIcon } from '@canopy/ui-shared/icons/AppIcons';
import { Bar, type Act } from '../../../../../vendor/stageshow/kit';
import { LabStage, LabWindow, NameWithin } from './componentsLabStage';

/*
 * Stageshow stages for the unified controls: each is one short story told
 * with the real shared component inside a Canopy window. Every stage plays
 * once and holds its payoff; its poster is the frame that tells the story on
 * its own. Real strings are kept to what the story is about; the rest is
 * the kit's placeholder `Bar`.
 */

function focusTarget(name: string): void {
  document
    .querySelector<HTMLElement>(
      `[data-target="${name}"] input, [data-target="${name}"] textarea, input[data-target="${name}"]`,
    )
    ?.focus({ preventScroll: true });
}

function blurTarget(name: string): void {
  document
    .querySelector<HTMLElement>(
      `[data-target="${name}"] input, input[data-target="${name}"]`,
    )
    ?.blur();
}

// --- Button: hover, press, busy, done ---------------------------------------

type ButtonScene = { busy: boolean; done: boolean };

async function buttonScript(a: Act<ButtonScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'button-cancel', x: 0.7, y: 0.65 });
  await a.wait(700);
  await a.move({ at: 'button-create', x: 0.82, y: 0.65 });
  await a.wait(500);
  a.mark('press');
  await a.click();
  a.put({ busy: true });
  await a.wait(1700);
  a.mark('done');
  a.put({ busy: false, done: true });
  await a.move({ at: 'button-create', x: 0.7, y: 2.2 });
  await a.wait(2000);
}

export function ButtonStage(): JSX.Element {
  return (
    <LabStage<ButtonScene>
      id="button"
      initial={{ busy: false, done: false }}
      poster={{ busy: true, done: false }}
      script={buttonScript}
      height={210}
    >
      {(s, _rect, layout): JSX.Element => (
        <LabWindow title="New pull request">
          <div className="canopy-lab-body">
            <div className="flex flex-col gap-2">
              <div className="text-s font-medium fg-primary">
                Fix sidebar collapse at 200%
              </div>
              <Bar w={300} h={7} tone={3} />
              <Bar w={220} h={7} tone={3} />
            </div>
            {/* Primary last, the row left-aligned: the busy and done labels
                change only the primary's own width, so nothing beside it
                moves. */}
            <div className="flex items-center gap-2">
              <Button data-target="button-cancel">Cancel</Button>
              <Button
                data-target="button-create"
                variant={s.done ? 'secondary' : 'primary'}
                loading={s.busy}
                loadingLabel="Creating…"
              >
                {s.done ? 'View pull request' : 'Create pull request'}
              </Button>
              {layout === 'wide' ? (
                <div className="flex flex-1 justify-end">
                  <Button variant="ghost" disabled>
                    Save as draft
                  </Button>
                </div>
              ) : null}
            </div>
            <div className="flex flex-col gap-2">
              <Bar w={280} h={7} tone={2} />
              <Bar w={200} h={7} tone={2} />
            </div>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- ListRow: hover travels down the list, a click selects ------------------

const CHATS = [
  { id: 'notes', title: 'Release notes draft', time: '2m' },
  { id: 'flaky', title: 'Fix flaky checkout test', time: '18m' },
  { id: 'zoom', title: 'Sidebar collapse at 200%', time: '1h' },
  { id: 'tokens', title: 'Color tokens audit', time: '3h' },
  { id: 'deps', title: 'Bump Electron to 39', time: '1d' },
] as const;

type ListScene = { selected: string };

async function listScript(a: Act<ListScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'row-zoom', x: 0.55, y: 0.6 });
  await a.wait(600);
  await a.move({ at: 'row-flaky', x: 0.55, y: 0.6 });
  await a.wait(400);
  a.mark('select');
  await a.click();
  a.put({ selected: 'flaky' });
  await a.wait(500);
  await a.move({ at: 'row-flaky', x: 0.55, y: 3.4 });
  await a.wait(2000);
}

export function ListRowStage(): JSX.Element {
  return (
    <LabStage<ListScene>
      id="list-row"
      initial={{ selected: 'notes' }}
      poster={{ selected: 'flaky' }}
      script={listScript}
      height={262}
    >
      {(s): JSX.Element => (
        <LabWindow title="Chats">
          <div className="canopy-lab-sidebar-body">
            {CHATS.map((chat) => (
              <ListRow
                key={chat.id}
                data-target={`row-${chat.id}`}
                icon={<ChatIcon />}
                trailing={chat.time}
                selected={s.selected === chat.id}
              >
                {chat.title}
              </ListRow>
            ))}
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Markers: a run finishes on its own -------------------------------------

type MarkersScene = { finished: boolean };

async function markersScript(a: Act<MarkersScene>): Promise<void> {
  await a.wait(1800);
  a.mark('finish');
  a.put({ finished: true });
  await a.wait(2400);
}

export function MarkersStage(): JSX.Element {
  return (
    <LabStage<MarkersScene>
      id="markers"
      initial={{ finished: false }}
      poster={{ finished: true }}
      script={markersScript}
      height={196}
      pointer={false}
    >
      {(s): JSX.Element => (
        <LabWindow title="Pipelines">
          <div className="canopy-lab-sidebar-body">
            <ListRow
              icon={
                <span className="canopy-lab-swap">
                  <span data-on={s.finished ? undefined : true}>
                    <StatusGlyph state="running" size={14} />
                  </span>
                  <span data-on={s.finished ? true : undefined}>
                    <StatusGlyph state="done" size={14} />
                  </span>
                </span>
              }
              trailing={
                <span className="canopy-lab-swap justify-items-end">
                  <span data-on={s.finished ? undefined : true}>
                    <Badge tone="info">Running</Badge>
                  </span>
                  <span data-on={s.finished ? true : undefined}>
                    <Badge tone="success">Passed</Badge>
                  </span>
                </span>
              }
            >
              Code review
            </ListRow>
            <ListRow
              icon={<StatusGlyph state="failed" size={14} />}
              trailing={<Badge tone="danger">Failed</Badge>}
            >
              Unit tests
            </ListRow>
            <ListRow
              icon={<StatusGlyph state="queued" size={14} />}
              trailing={<Badge>Queued</Badge>}
            >
              Release build
            </ListRow>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Chip: hover, the remove control, gone ----------------------------------

type ChipScene = {
  look: 'rest' | 'hover' | 'remove-hover';
  removed: boolean;
};

async function chipScript(a: Act<ChipScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'chip-design', x: 0.35, y: 0.6 });
  a.put({ look: 'hover' });
  await a.wait(700);
  await a.move({ at: 'chip-design', x: 0.9, y: 0.55 });
  a.put({ look: 'remove-hover' });
  await a.wait(500);
  a.mark('remove');
  await a.click();
  a.put({ removed: true, look: 'rest' });
  await a.wait(400);
  await a.move({ at: 'chip-composer', x: 0.8, y: 0.35 });
  await a.wait(2000);
}

const noop = (): void => undefined;

export function ChipStage(): JSX.Element {
  return (
    <LabStage<ChipScene>
      id="chip"
      initial={{ look: 'rest', removed: false }}
      poster={{ look: 'remove-hover', removed: false }}
      script={chipScript}
      height={196}
      compactHeight={150}
    >
      {(s, _rect, layout): JSX.Element => (
        <LabWindow title="New chat">
          <div className="canopy-lab-body">
            <div className="flex items-center gap-1.5">
              {layout === 'wide' ? (
                <Chip icon={FileIcon} onClick={noop} onRemove={noop}>
                  README.md
                </Chip>
              ) : null}
              <span
                className="canopy-lab-reveal-x"
                data-closed={s.removed ? true : undefined}
              >
                <span data-target="chip-design" className="inline-flex">
                  <Chip
                    icon={FileIcon}
                    onClick={noop}
                    onRemove={noop}
                    forcedState={s.look === 'rest' ? undefined : s.look}
                  >
                    design.png
                  </Chip>
                </span>
              </span>
              <Chip onClick={noop}>Fast</Chip>
            </div>
            <div data-target="chip-composer">
              <TextArea
                aria-label="Message"
                placeholder="Ask anything"
                rows={3}
              />
            </div>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- TabBar: hover, then a switch -------------------------------------------

type PipelineTab = 'overview' | 'runs' | 'settings';
type TabScene = { tab: PipelineTab };

async function tabScript(a: Act<TabScene>): Promise<void> {
  await a.wait(600);
  await a.move({ at: 'tab-runs', x: 0.7, y: 0.6 });
  await a.wait(500);
  a.mark('switch');
  await a.click();
  a.put({ tab: 'runs' });
  await a.wait(600);
  await a.move({ at: 'tab-runs', x: 3.2, y: 1.9 });
  await a.wait(2000);
}

export function TabBarStage(): JSX.Element {
  return (
    <LabStage<TabScene>
      id="tab-bar"
      initial={{ tab: 'overview' }}
      poster={{ tab: 'runs' }}
      script={tabScript}
      height={224}
    >
      {(s, _rect, layout): JSX.Element => (
        <LabWindow title="Code review">
          <div className="canopy-lab-body">
            {/* In the phone column the tab list hugs its tabs, so its rule
                ends with them instead of running on past the last one. */}
            <div className={layout === 'compact' ? 'w-fit' : undefined}>
              <NameWithin name="tab-runs" text="Runs">
                <TabBar
                  label="Pipeline sections"
                  items={[
                    { id: 'overview', label: 'Overview' },
                    { id: 'runs', label: 'Runs', count: 12 },
                    { id: 'settings', label: 'Settings' },
                  ]}
                  value={s.tab}
                  onChange={noop}
                />
              </NameWithin>
            </div>
            <div className="canopy-lab-swap">
              <div data-on={s.tab === 'overview' ? true : undefined}>
                <FactList labelWidth="6rem" size="s">
                  <Fact label="Last run">4 minutes ago</Fact>
                  <Fact label="Pass rate" numeric>
                    92%
                  </Fact>
                  <Fact label="Reviewers" numeric>
                    2
                  </Fact>
                </FactList>
              </div>
              <div
                className="flex flex-col gap-0.5"
                data-on={s.tab === 'runs' ? true : undefined}
              >
                <ListRow
                  icon={<StatusGlyph state="done" size={14} />}
                  trailing="4m"
                >
                  Run 12
                </ListRow>
                <ListRow
                  icon={<StatusGlyph state="failed" size={14} />}
                  trailing="2h"
                >
                  Run 11
                </ListRow>
              </div>
            </div>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- SegmentedControl: the surface slides to Dark ---------------------------

type Mode = 'light' | 'dark' | 'system';
type SegmentedScene = { mode: Mode };

async function segmentedScript(a: Act<SegmentedScene>): Promise<void> {
  await a.wait(700);
  await a.move({ at: 'appearance-dark', x: 0.7, y: 0.6 });
  await a.wait(400);
  a.mark('switch');
  await a.click();
  a.put({ mode: 'dark' });
  await a.wait(700);
  await a.move({ at: 'appearance-dark', x: -3, y: 2.2 });
  await a.wait(2000);
}

export function SegmentedControlStage(): JSX.Element {
  return (
    <LabStage<SegmentedScene>
      id="segmented-control"
      initial={{ mode: 'light' }}
      poster={{ mode: 'dark' }}
      script={segmentedScript}
      height={232}
    >
      {(s, _rect, layout): JSX.Element => (
        <LabWindow title="Settings">
          <div className="canopy-lab-body">
            <SettingsRowsGroup>
              <SettingsRowsRow
                label="Appearance"
                control={
                  <NameWithin name="appearance-dark" text="Dark">
                    <SegmentedControl
                      label="Appearance"
                      value={s.mode}
                      // The phone window has no room for the row's label
                      // beside a control-width picker of three.
                      width={layout === 'compact' ? 'content' : 'control'}
                      onChange={noop}
                      options={[
                        { value: 'light', label: 'Light' },
                        { value: 'dark', label: 'Dark' },
                        { value: 'system', label: 'System' },
                      ]}
                    />
                  </NameWithin>
                }
              />
              <SettingsRowsRow
                label="Density"
                control={
                  <SegmentedControl
                    label="Density"
                    value="comfortable"
                    onChange={noop}
                    options={[
                      { value: 'comfortable', label: 'Comfortable' },
                      { value: 'compact', label: 'Compact' },
                    ]}
                  />
                }
              />
            </SettingsRowsGroup>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}

// --- Fields: an error after submit, cleared by the edit ---------------------

type FieldScene = {
  branch: string;
  error: boolean;
  busy: boolean;
  done: boolean;
};

async function fieldScript(a: Act<FieldScene>): Promise<void> {
  await a.wait(500);
  await a.move({ at: 'branch-field', x: 0.3, y: 0.5 });
  await a.click();
  focusTarget('branch-field');
  a.mark('type');
  await a.type('branch', 'fix sidebar zoom', { interval: 55 });
  await a.wait(300);
  await a.move({ at: 'branch-create', x: 0.8, y: 0.6 });
  await a.click();
  a.mark('error');
  a.put({ error: true });
  await a.wait(1400);
  await a.move({ at: 'branch-field', x: 0.5, y: 0.5 });
  await a.click();
  focusTarget('branch-field');
  a.mark('fix');
  // Only the spaces change: the edit drops the error at once.
  a.put({ branch: 'fix-sidebar zoom', error: false });
  await a.wait(220);
  a.put({ branch: 'fix-sidebar-zoom' });
  await a.wait(600);
  await a.move({ at: 'branch-create', x: 0.8, y: 0.6 });
  await a.click();
  blurTarget('branch-field');
  a.put({ busy: true });
  await a.wait(1400);
  a.mark('done');
  a.put({ busy: false, done: true });
  await a.move({ at: 'branch-create', x: 0.7, y: 2.2 });
  await a.wait(2000);
}

export function FieldsStage(): JSX.Element {
  return (
    <LabStage<FieldScene>
      id="fields"
      initial={{ branch: '', error: false, busy: false, done: false }}
      poster={{
        branch: 'fix sidebar zoom',
        error: true,
        busy: false,
        done: false,
      }}
      script={fieldScript}
      height={232}
    >
      {(s): JSX.Element => (
        <LabWindow title="New branch">
          <div className="canopy-lab-body">
            {/* The error gets a lane from the start, so when it arrives the
                button under the field stays where it is. */}
            <div style={{ minHeight: 86 }}>
              <FormField
                label="Branch name"
                error={
                  s.error ? 'Use letters, numbers and dashes, no spaces.' : null
                }
              >
                {(control): JSX.Element => (
                  <div data-target="branch-field" data-cursor="ibeam">
                    <TextInput
                      {...control}
                      value={s.branch}
                      onChange={noop}
                      placeholder="feature/name"
                    />
                  </div>
                )}
              </FormField>
            </div>
            <div className="flex justify-end">
              <Button
                data-target="branch-create"
                variant={s.done ? 'secondary' : 'primary'}
                loading={s.busy}
                loadingLabel="Creating…"
              >
                {s.done ? 'Branch created' : 'Create branch'}
              </Button>
            </div>
          </div>
        </LabWindow>
      )}
    </LabStage>
  );
}
