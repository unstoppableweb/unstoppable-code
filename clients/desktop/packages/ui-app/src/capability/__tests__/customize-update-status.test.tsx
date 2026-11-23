/** @jest-environment jsdom */
/**
 * The update status on an item's detail page in New Customize (CAN-7548). A
 * skill, a plugin and an automation each say whether they are current in the
 * same place, the Version row, with the same reload icon after it, named for
 * what it does and never for the item. Mounted through the real
 * `SkillReadDetail`, `PluginDetailHost` and `AutomationReadDetail` under the
 * `CustomizeDiscoveryProvider` the hosts mount, with host-shaped props.
 */
import { act, type JSX, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AutomationReadDetail,
  DetailVersionUpdateFact,
  type DetailVersionUpdate,
} from '@canopy/ui-shared/components';
import type { SkillUpdateAction } from '@canopy/ui-shared/lib/skill-update-action';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { CustomizeDiscoveryProvider } from '../CustomizeDiscoveryProvider';
import {
  PluginDetailHost,
  type PluginDetailHostPlugin,
} from '../PluginDetailHost';
import {
  SkillReadDetail,
  installedSkillDetailHeader,
  type SkillReadDetailHeader,
} from '../SkillReadDetail';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: ReactNode): void {
  act(() => root.render(node));
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function click(element: Element | null | undefined): void {
  if (!(element instanceof HTMLElement)) throw new Error('Nothing to click');
  act(() => element.click());
}

/** What each state's status says in the Version row, as the component words it. */
const STATUS: Record<string, string> = {
  available: 'Update available',
  current: 'Up to date',
  unknown: 'Update status unknown',
  checking: 'Checking for updates…',
  applying: 'Updating…',
};
const FAILED = /^(No longer in its source|Couldn’t )/;

type Icon = { label: string; busy: boolean } | null;
const CHECK = { label: 'Check for updates', busy: false };
const UPDATE = { label: 'Update', busy: false };
const CHECKING = { label: 'Checking for updates…', busy: true };
const UPDATING = { label: 'Updating…', busy: true };
/** Item names and versions: never outside session replay's block. */
const PRIVATE = ['quartz', 'opal', 'nightly', 'v1.2.0', '2.4.0', '2.5.0'];

/**
 * The row's state (its `data-state`), the icon after it (its accessible
 * name, and `busy` while `aria-disabled`: a natively disabled icon would
 * leave the tab order), and the version under session replay's block. The
 * row's visible status says its state's words (or a failure's), not just
 * its `data-state`.
 */
function rowOf(testId: string): {
  state: string | null;
  icon: Icon;
  version: string | null;
} {
  const row = byTestId(testId);
  if (!row) throw new Error(`No row ${testId}`);
  const group = row.querySelector('[data-state]');
  const open = row.cloneNode(true);
  if (!(open instanceof HTMLElement)) throw new Error('Not an element');
  open.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`).forEach((n) => n.remove());
  const exposed = Array.from(
    open.querySelectorAll('[aria-label], [title]'),
    (n) => `${n.getAttribute('aria-label')} ${n.getAttribute('title')}`,
  );
  const said = [open.textContent, ...exposed].join(' ').toLowerCase();
  expect(PRIVATE.filter((needle) => said.includes(needle))).toEqual([]);
  const status = row.querySelector('[role="status"]');
  const state = group?.getAttribute('data-state') ?? null;
  if (status?.getAttribute('data-testid') === `${testId}-error`) {
    expect(status.textContent).toMatch(FAILED);
  } else {
    expect(status?.textContent).toBe(state && STATUS[state]);
  }
  const icon = byTestId(`${testId}-run`);
  if (icon) {
    expect(icon.closest('[data-state]')).toBe(group);
    expect(icon.querySelector('svg')).not.toBeNull();
    expect(icon).toHaveProperty('disabled', false);
  }
  return {
    state,
    icon: icon && {
      label: icon.getAttribute('aria-label') ?? '',
      busy: icon.getAttribute('aria-disabled') === 'true',
    },
    version: row.querySelector(`.${REPLAY_BLOCK_CLASS}`)?.textContent ?? null,
  };
}

type Ready = Extract<SkillUpdateAction, { status: 'ready' }>;

function ready(overrides: Partial<Ready> = {}): Ready {
  return {
    status: 'ready',
    updateAvailable: false,
    pending: 'none',
    onCheck: jest.fn(),
    onApply: jest.fn(),
    ...overrides,
  };
}

const BLOCKED = (updateAvailable: boolean): SkillUpdateAction => ({
  status: 'blocked',
  updateAvailable,
  reason: 'Update from the desktop app.',
});
const MISSING = { kind: 'missing-source' } as const;
const onRemove = jest.fn();

function skillPage(
  action: SkillUpdateAction | undefined,
  extra: {
    shareUpdate?: { run: () => void };
    versionError?: string;
    header?: SkillReadDetailHeader;
  } = {},
  enabled = true,
): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled={enabled}>
      <SkillReadDetail
        skill={{ sourceId: 'local', name: 'quartz-planner' }}
        header={{
          title: 'Quartz Planner',
          version: 'v1.2.0',
          meta: ['Custom'],
        }}
        content={{ frontmatter: {}, body: 'Plans things.' }}
        files={['SKILL.md']}
        loading={false}
        error=""
        readFile={() =>
          Promise.resolve({ content: '', truncated: false, binary: false })
        }
        updateAction={action}
        onRemove={onRemove}
        {...extra}
      />
    </CustomizeDiscoveryProvider>
  );
}

const PLUGIN: PluginDetailHostPlugin = {
  name: 'Opal Review',
  marketplaceId: 'acme',
  version: '2.4.0',
  providerSupport: { claude: 'native', codex: 'none' },
};

function pluginPage(
  versionUpdate?: DetailVersionUpdate,
  enabled = true,
): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled={enabled}>
      <PluginDetailHost
        plugin={PLUGIN}
        loadDetail={() => Promise.resolve(PLUGIN)}
        readComponent={() => Promise.resolve(null)}
        {...(versionUpdate ? { versionUpdate } : {})}
      />
    </CustomizeDiscoveryProvider>
  );
}

function automationPage(
  update?: DetailVersionUpdate,
  enabled = true,
  verifiedCurrent?: boolean,
): JSX.Element {
  return (
    <CustomizeDiscoveryProvider enabled={enabled}>
      <AutomationReadDetail
        name="Nightly Triage"
        description="Sorts the inbox."
        logo={null}
        {...(verifiedCurrent === undefined ? {} : { verifiedCurrent })}
        // As the desktop host draws its row: named, for the flag-off link.
        version={
          update ? (
            <DetailVersionUpdateFact
              name="Nightly Triage"
              testId={AUTOMATION}
              update={update}
            />
          ) : undefined
        }
      />
    </CustomizeDiscoveryProvider>
  );
}

const SKILL = 'skill-version-fact';
const PLUGIN_ROW = 'detail-version-update';
const AUTOMATION = 'automation-catalog-update';
const share = { shareUpdate: { run: jest.fn() } };

const ACTIONS = {
  never: ready(),
  current: ready({ checkedAt: Date.now() }),
  checking: ready({ pending: 'checking' }),
  applying: ready({ pending: 'applying', updateAvailable: true }),
  available: ready({ updateAvailable: true }),
  missing: ready({ updateAvailable: true, error: MISSING }),
  blockedAvailable: BLOCKED(true),
  blockedUnknown: BLOCKED(false),
  none: undefined,
};

/** [the skill's update action, its state, its icon, a shared copy?] */
const SKILL_STATES: ReadonlyArray<
  readonly [keyof typeof ACTIONS, string, Icon, boolean?]
> = [
  ['never', 'unknown', CHECK],
  ['current', 'current', CHECK],
  ['checking', 'checking', CHECKING],
  ['applying', 'applying', UPDATING],
  ['available', 'available', UPDATE],
  // Nothing in its source to update to: the icon checks again.
  ['missing', 'unknown', CHECK],
  // A host that can't run updates says what it knows, with no icon.
  ['blockedAvailable', 'available', null],
  ['blockedUnknown', 'unknown', null],
  ['none', 'unknown', null],
  // A shared copy's update is the one available; a ⋯ check shows here too.
  ['never', 'available', UPDATE, true],
  ['checking', 'checking', CHECKING, true],
  ['blockedUnknown', 'available', UPDATE, true],
];

/** [the host's update, its state, its icon, the version on the row] */
const PLUGIN_STATES: ReadonlyArray<
  readonly [DetailVersionUpdate | undefined, string, Icon, string]
> = [
  [undefined, 'unknown', null, '2.4.0'],
  [{ state: 'current', check: jest.fn() }, 'current', CHECK, '2.4.0'],
  // As the desktop host supplies a changed shared source: a version alone.
  [{ version: '2.5.0' }, 'available', null, '2.5.0'],
  [{}, 'available', null, '2.4.0'],
  [{ run: jest.fn() }, 'available', UPDATE, '2.4.0'],
];

const AUTOMATION_STATES: ReadonlyArray<
  readonly [DetailVersionUpdate | undefined, string, Icon]
> = [
  [undefined, 'unknown', null],
  [{ run: jest.fn() }, 'available', UPDATE],
  [{ busy: true, run: jest.fn() }, 'applying', UPDATING],
  [{ busy: true }, 'applying', null],
];

/**
 * Focuses the icon on the first page, then renders the rest: the same icon
 * keeps focus, and the row's one status is its failure.
 */
function keepsFocus(testId: string, pages: readonly JSX.Element[]): void {
  const [first, ...rest] = pages;
  render(first);
  const icon = byTestId(`${testId}-run`);
  act(() => icon?.focus());
  for (const page of rest) render(page);
  expect(byTestId(`${testId}-run`)).toBe(icon);
  expect(document.activeElement).toBe(icon);
  const statuses = byTestId(testId)?.querySelectorAll('[role="status"]');
  expect(Array.from(statuses ?? [])).toEqual([byTestId(`${testId}-error`)]);
}

describe('the Version row (CAN-7548)', () => {
  for (const [key, state, icon, shared] of SKILL_STATES) {
    it(`skill ${key}${shared ? ', shared copy' : ''}: ${state}`, () => {
      render(skillPage(ACTIONS[key], shared ? share : {}));
      expect(rowOf(SKILL)).toEqual({ state, icon, version: 'v1.2.0' });
      // One place says it: the header's status is the flag-off page's.
      expect(byTestId('skill-update-status')).toBeNull();
    });
  }
  for (const [update, state, icon, version] of PLUGIN_STATES) {
    it(`plugin ${JSON.stringify(update)}: ${state}`, () => {
      render(pluginPage(update));
      expect(rowOf(PLUGIN_ROW)).toEqual({ state, icon, version });
    });
  }
  for (const [update, state, icon] of AUTOMATION_STATES) {
    it(`automation ${JSON.stringify(update)}: ${state}`, () => {
      render(automationPage(update));
      expect(rowOf(AUTOMATION)).toEqual({ state, icon, version: null });
    });
  }

  it('plugin: an external plugin says updating while its Update runs, then its host state', async () => {
    let finish: (plugin: PluginDetailHostPlugin) => void = () => undefined;
    const onInstall = jest.fn(
      () =>
        new Promise<PluginDetailHostPlugin>((resolve) => {
          finish = resolve;
        }),
    );
    const external = { ...PLUGIN, externalSource: 'https://example.test/opal' };
    render(
      <CustomizeDiscoveryProvider enabled>
        <PluginDetailHost
          plugin={external}
          loadDetail={() => Promise.resolve(external)}
          readComponent={() => Promise.resolve(null)}
          onInstall={onInstall}
        />
      </CustomizeDiscoveryProvider>,
    );
    expect(rowOf(PLUGIN_ROW).state).toBe('unknown');
    click(byTestId('plugin-detail-more'));
    // The open menu is a portal.
    const update = document.querySelector<HTMLElement>(
      '[data-testid="plugin-detail-update"]',
    );
    click(update);
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(rowOf(PLUGIN_ROW)).toEqual({
      state: 'applying',
      icon: null,
      version: '2.4.0',
    });
    await act(async () => {
      finish(external);
      await Promise.resolve();
    });
    expect(rowOf(PLUGIN_ROW).state).toBe('unknown');
  });

  it('automation: a verified-current copy says up to date, an unchecked one unknown', () => {
    render(automationPage(undefined, true, true));
    expect(rowOf(AUTOMATION)).toEqual({
      state: 'current',
      icon: null,
      version: null,
    });
    render(automationPage(undefined, true, false));
    expect(rowOf(AUTOMATION)?.state).toBe('unknown');
    render(automationPage(undefined, true));
    expect(rowOf(AUTOMATION)?.state).toBe('unknown');
    render(automationPage(undefined, false, true));
    expect(byTestId(AUTOMATION)).toBeNull();
  });

  it('skill: a shared source a live read found changed is available without an update to run', () => {
    // As the desktop host builds a private-scope receipt's page: the badge's
    // fact, with no review to open, so no `shareUpdate`.
    const changed = (updateAvailable: boolean): SkillReadDetailHeader =>
      installedSkillDetailHeader(
        'quartz-planner',
        null,
        {
          source: 'local',
          custom: true,
          description: '',
          installedAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
          installedFromShare: { remoteId: 'r1', contentHash: 'a'.repeat(64) },
        },
        undefined,
        undefined,
        { updateAvailable },
      );
    for (const action of [undefined, ready()]) {
      render(skillPage(action, { header: changed(true) }));
      expect(rowOf(SKILL)).toMatchObject({ state: 'available', icon: null });
    }
    render(skillPage(undefined, { header: changed(false) }));
    expect(rowOf(SKILL).state).toBe('unknown');
  });

  it('runs what its icon names, and once', () => {
    const fresh = ready();
    const newer = ready({ updateAvailable: true });
    const missing = ready({ updateAvailable: true, error: MISSING });
    const shared = ready();
    const shareRun = jest.fn();
    const check = jest.fn();
    const run = jest.fn();
    const cases: ReadonlyArray<readonly [JSX.Element, string, () => void]> = [
      [skillPage(fresh), SKILL, fresh.onCheck],
      [skillPage(newer), SKILL, newer.onApply],
      [skillPage(missing), SKILL, missing.onCheck],
      [skillPage(shared, { shareUpdate: { run: shareRun } }), SKILL, shareRun],
      [pluginPage({ state: 'current', check }), PLUGIN_ROW, check],
      [automationPage({ run }), AUTOMATION, run],
    ];
    for (const [page, testId, handler] of cases) {
      render(page);
      click(byTestId(`${testId}-run`));
      expect(handler).toHaveBeenCalledTimes(1);
    }
    expect(missing.onApply).not.toHaveBeenCalled();
    expect(shared.onApply).not.toHaveBeenCalled();
    render(automationPage({ busy: true, run }));
    click(byTestId(`${AUTOMATION}-run`));
    expect(run).toHaveBeenCalledTimes(1);
    // The labelled ⋯ item keeps the check; the open menu is a portal.
    render(skillPage(newer));
    click(byTestId('skill-read-detail-more'));
    expect(
      document.querySelector('[data-testid="skill-read-detail-check-updates"]'),
    ).not.toBeNull();
  });

  it('says when the check that found nothing newer ran, and keeps counting', () => {
    jest.useFakeTimers();
    try {
      render(skillPage(ready({ checkedAt: Date.now() })));
      const fresh = byTestId(`${SKILL}-checked`)?.textContent;
      expect(fresh).toMatch(/^Checked /);
      act(() => jest.advanceTimersByTime(61_000));
      expect(byTestId(`${SKILL}-checked`)?.textContent).not.toBe(fresh);
    } finally {
      jest.useRealTimers();
    }
  });

  // The control a keyboard user pressed survives its run and its failure.
  it('keeps the focused icon through a failed check, and retries it', () => {
    const failed = ready({
      error: { kind: 'check-failed', detail: 'offline' },
    });
    const idle = [ACTIONS.never, ACTIONS.checking].map((a) => skillPage(a));
    keepsFocus(SKILL, [...idle, skillPage(failed)]);
    click(byTestId(`${SKILL}-retry`));
    expect(failed.onCheck).toHaveBeenCalledTimes(1);
    // On a shared copy too, whose icon updates.
    keepsFocus(SKILL, [skillPage(ready(), share), skillPage(failed, share)]);
  });

  it('keeps the focused icon through a failed update, and retries it', () => {
    const failed = ready({
      updateAvailable: true,
      error: { kind: 'update-failed', detail: 'no space' },
    });
    const pages = [ACTIONS.available, ACTIONS.applying, failed];
    keepsFocus(
      SKILL,
      pages.map((a) => skillPage(a)),
    );
    click(byTestId(`${SKILL}-retry`));
    expect(failed.onApply).toHaveBeenCalledTimes(1);
    const run = jest.fn();
    keepsFocus(AUTOMATION, [
      automationPage({ run }),
      automationPage({ run, busy: true }),
      automationPage({ run, error: 'Could not update' }),
    ]);
  });

  it("keeps a diagnostic that names the skill under replay's block, off the tooltip", () => {
    const detail = 'rename /skills/quartz-planner.tmp: EXDEV';
    for (const error of [
      { kind: 'check-failed', detail },
      { kind: 'update-failed', detail },
    ] as const) {
      render(skillPage(ready({ error })));
      // `rowOf` finds no name, in text or in a title, outside the block.
      rowOf(SKILL);
      const blocked = Array.from(
        byTestId(`${SKILL}-error`)?.querySelectorAll(
          `.${REPLAY_BLOCK_CLASS}`,
        ) ?? [],
        (n) => n.textContent,
      );
      expect(blocked).toEqual([detail]);
      // A long diagnostic wraps instead of clipping, and stays off the title.
      const text = byTestId(`${SKILL}-error`)?.querySelector('[title]');
      expect(text?.classList.contains('truncate')).toBe(false);
      expect(text?.getAttribute('title')).not.toContain(detail);
    }
  });

  it('keeps the focused icon when the skill is gone, or its re-read fails', () => {
    keepsFocus(SKILL, [
      skillPage(ACTIONS.checking),
      skillPage(ready({ error: MISSING })),
    ]);
    click(byTestId(`${SKILL}-retry`));
    expect(onRemove).toHaveBeenCalledTimes(1);
    keepsFocus(SKILL, [
      skillPage(ACTIONS.current),
      skillPage(ACTIONS.current, { versionError: 'Could not read it' }),
    ]);
  });
});

describe('with the flag off (CAN-7548)', () => {
  it('shows none of the new rows or icons', () => {
    render(skillPage(ACTIONS.current, {}, false));
    expect(byTestId(SKILL)).toBeNull();
    expect(byTestId('skill-update-status')).not.toBeNull();
    render(skillPage(ACTIONS.available, {}, false));
    expect(byTestId(SKILL)).toBeNull();
    expect(byTestId('skill-update-notice')).not.toBeNull();
    render(pluginPage({ state: 'current', check: jest.fn() }, false));
    expect(byTestId(PLUGIN_ROW)).toBeNull();
    render(automationPage(undefined, false));
    expect(byTestId(AUTOMATION)).toBeNull();
    // A host's own update row stays today's: no state, a named text link.
    render(automationPage({ run: jest.fn() }, false));
    expect(byTestId(AUTOMATION)?.querySelector('[data-state]')).toBeNull();
    expect(byTestId(`${AUTOMATION}-run`)?.getAttribute('aria-label')).toBe(
      'Update Nightly Triage',
    );
  });
});
