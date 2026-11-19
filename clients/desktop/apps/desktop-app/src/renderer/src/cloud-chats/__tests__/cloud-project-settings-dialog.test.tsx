/** @jest-environment jsdom */
import './jsdom-globals';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  coreCoworkSidebarRows,
  type CanopyCoreRelayLikeReply,
  type CoreCoworkInvoker,
} from '@canopy/app-state/core-cowork';
import {
  CloudProjectSettingsDialog,
  CloudProjectSettingsHost,
  type CloudProjectSettingsDialogProps,
} from '../CloudProjectSettingsDialog';
import { CLOUD_PROJECT_DANGER_COPY } from '../cloud-sidebar-capabilities';
import type { CloudCoworkSidebarModel } from '../useCloudCoworkSidebar';
import {
  POSTHOG_REPLAY_BLOCK_CLASS,
  POSTHOG_REPLAY_MASK_CLASS,
} from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { CloudProjectHostTab, CloudProjectNetworkTab } from '@canopy/ui-app';
import {
  CoreCoworkRequestError,
  type CoreCoworkProjectPatch,
  type CoreCoworkProjectSaved,
} from '@canopy/app-state/core-cowork';
import * as instrumentation from '@canopy/desktop-instrumentation/client';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// A cloud project's settings on desktop (CAN-7053): its instructions, default
// plugins, egress hosts and host settings over the web core, beside the name,
// colour and delete the sidebar already offered.

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = `web-core:${WORKSPACE}`;

/** A project save that landed, as the store answers it. */
const SAVED = (
  warnings: readonly string[] = [],
  revision?: number,
): Promise<CoreCoworkProjectSaved> => Promise.resolve({ warnings, revision });

const STALE = (): CoreCoworkRequestError =>
  new CoreCoworkRequestError({
    kind: 'conflict',
    code: 'core.workspace.revisionConflict',
    message: 'The project changed.',
    retry: { kind: 'never' },
  });

/**
 * The web core's project update over `core`: refused at any other revision;
 * a save that lands stores its fields and moves the revision by one,
 * answering `warnings` in order.
 */
function storedUpdate(
  core: FakeWebCore,
  warnings: (readonly string[])[] = [],
): jest.Mock<
  Promise<CoreCoworkProjectSaved>,
  [CoreCoworkProjectPatch, { readonly expectedRevision?: number }]
> {
  core.revision ??= 1;
  return jest.fn(
    (
      patch: CoreCoworkProjectPatch,
      options: { readonly expectedRevision?: number },
    ): Promise<CoreCoworkProjectSaved> => {
      if (options.expectedRevision !== core.revision)
        return Promise.reject(STALE());
      if (patch.egressAllowedHosts !== undefined)
        core.egressAllowedHosts = [...patch.egressAllowedHosts];
      if (patch.hostModeEnabled !== undefined)
        core.hostModeEnabled = patch.hostModeEnabled;
      if (patch.hostPorts !== undefined) core.hostPorts = [...patch.hostPorts];
      core.revision = (core.revision ?? 0) + 1;
      return SAVED(warnings.shift(), core.revision);
    },
  );
}

class FakeWebCore implements CoreCoworkInvoker {
  readonly calls: { method: string; params: Record<string, unknown> }[] = [];
  instructions = 'Be brief.';
  instructionsRefusal = false;
  /** Warnings the next instructions saves answer, in order. */
  readonly instructionsWarnings: string[][] = [];
  readFails = false;
  /** The stored default plugins and their revision. */
  defaults: Record<string, unknown> | null = null;
  defaultsRevision = 2;
  /** Refusals the next default plugins saves answer, in order. */
  readonly pluginRefusals: CanopyCoreRelayLikeReply[] = [];
  /** The project's catalog snapshot entries. */
  catalogEntries: Record<string, unknown>[] = [];
  /** The project revision core.workspace.get answers, when set. */
  revision: number | undefined = undefined;
  /** The stored sandbox settings (CAN-7053 PR B). */
  hostModeEnabled = false;
  hostPorts: number[] = [];
  egressAllowedHosts: string[] = [];
  /** The sandbox's routes answer, or null for a refused read. */
  sandboxRoutes: Record<string, unknown> | null = null;

  request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<CanopyCoreRelayLikeReply> {
    this.calls.push({ method, params });
    if (method === 'core.workspace.get')
      return Promise.resolve(
        this.readFails
          ? {
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The web core is offline.',
                retry: { kind: 'never' },
              },
            }
          : {
              ok: true,
              value: {
                ...(this.revision === undefined
                  ? {}
                  : { revision: this.revision }),
                cloudSettings: {
                  hostModeEnabled: this.hostModeEnabled,
                  hostPorts: this.hostPorts,
                  egressAllowedHosts: this.egressAllowedHosts,
                  defaultAgentInstructions: this.instructions,
                  defaultPluginSelections: this.defaults,
                  defaultPluginSelectionsRevision: this.defaultsRevision,
                },
              },
            },
      );
    if (method === 'core.workspace.sandboxRoutes.get')
      return Promise.resolve(
        this.sandboxRoutes === null
          ? {
              ok: false,
              error: {
                kind: 'unavailable',
                message: 'The sandbox could not be checked.',
                retry: { kind: 'never' },
              },
            }
          : { ok: true, value: this.sandboxRoutes },
      );
    if (method === 'core.catalog.snapshot.get')
      return Promise.resolve({
        ok: true,
        value: {
          revision: 1,
          entries: this.catalogEntries,
          generatedAt: '2026-11-17T00:00Z',
        },
      });
    if (method === 'core.workspace.plugins.update')
      return Promise.resolve(
        this.pluginRefusals.shift() ?? { ok: true, value: {} },
      );
    if (method === 'core.workspace.instructions.update') {
      if (this.instructionsRefusal)
        return Promise.resolve({
          ok: false,
          error: {
            kind: 'permission_denied',
            message: 'Only the owner can change this.',
            retry: { kind: 'never' },
          },
        });
      return Promise.resolve({
        ok: true,
        value: { warnings: this.instructionsWarnings.shift() ?? [] },
      });
    }
    return Promise.resolve({
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: `${method} is not served.`,
        retry: { kind: 'never' },
      },
    });
  }

  openStream(): never {
    throw new Error('Project settings open no stream.');
  }

  writes(): string[] {
    return this.calls
      .map((call) => call.method)
      .filter(
        (method) =>
          method !== 'core.workspace.get' &&
          method !== 'core.workspace.sandboxRoutes.get' &&
          method !== 'core.catalog.snapshot.get',
      );
  }
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
});

async function render(
  overrides: Partial<CloudProjectSettingsDialogProps> & {
    readonly invoker: CoreCoworkInvoker;
  },
): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    root.render(
      <CloudProjectSettingsDialog
        projectId={PROJECT_ID}
        name="Research"
        color="blue"
        dangerCopy={CLOUD_PROJECT_DANGER_COPY}
        onUpdateProject={() => SAVED()}
        onClose={() => undefined}
        {...overrides}
      />,
    );
  });
  // The settings and catalog reads settle.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const byTestId = (id: string): HTMLElement | null =>
  document.querySelector(`[data-testid="${id}"]`);

function tab(label: string): HTMLElement {
  const found = [...document.querySelectorAll('[role="tab"], button')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!(found instanceof HTMLElement)) throw new Error(`No ${label} tab`);
  return found;
}

const tabLabels = (): string[] =>
  [
    ...(byTestId('workspace-settings-pages')?.querySelectorAll(
      '[role="tab"], button',
    ) ?? []),
  ].map((element) => element.textContent?.trim() ?? '');

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(element: HTMLElement | null, value: string): Promise<void> {
  if (
    !(element instanceof HTMLTextAreaElement) &&
    !(element instanceof HTMLInputElement)
  )
    throw new Error('Not a text field');
  const prototype: unknown = Object.getPrototypeOf(element);
  const descriptor =
    typeof prototype === 'object' && prototype !== null
      ? Object.getOwnPropertyDescriptor(prototype, 'value')
      : undefined;
  await act(async () => {
    await Promise.resolve();
    // React tracks the value through the prototype's setter.
    const setter: unknown =
      descriptor === undefined ? undefined : Reflect.get(descriptor, 'set');
    if (typeof setter === 'function') Reflect.apply(setter, element, [value]);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function save(): Promise<void> {
  const button = byTestId('cloud-project-settings-save');
  if (!(button instanceof HTMLElement)) throw new Error('No Save');
  await click(button);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('cloud project settings on desktop (CAN-7053)', () => {
  it("offers General, Instructions, Network, Plugins, Host and Danger, reading the project's settings over the web core", async () => {
    const core = new FakeWebCore();
    await render({ invoker: core });
    expect(core.calls[0]).toEqual({
      method: 'core.workspace.get',
      params: { workspaceId: WORKSPACE, revision: 2 },
    });
    expect(tabLabels()).toEqual(
      expect.arrayContaining([
        'General',
        'Instructions',
        'Network',
        'Plugins',
        'Host',
      ]),
    );
    await click(tab('Instructions'));
    expect(
      (byTestId('cloud-project-settings-instructions') as HTMLTextAreaElement)
        .value,
    ).toBe('Be brief.');
    await click(tab('Plugins'));
    expect(byTestId('cloud-workspace-settings-plugins')).not.toBeNull();
    // Opening sends no write.
    expect(core.writes()).toEqual([]);
  });

  it('saves only what changed: an unchanged Save sends nothing, and new instructions are one whole overwrite', async () => {
    const core = new FakeWebCore();
    const onUpdateProject = jest.fn(() => SAVED());
    await render({ invoker: core, onUpdateProject });
    await save();
    expect(core.writes()).toEqual([]);
    expect(onUpdateProject).not.toHaveBeenCalled();

    await click(tab('Instructions'));
    await type(
      byTestId('cloud-project-settings-instructions'),
      'Cite sources.',
    );
    await save();
    expect(onUpdateProject).not.toHaveBeenCalled();
    expect(
      core.calls.filter(
        (call) => call.method === 'core.workspace.instructions.update',
      ),
    ).toEqual([
      {
        method: 'core.workspace.instructions.update',
        params: {
          workspaceId: WORKSPACE,
          content: 'Cite sources.',
          revision: 2,
        },
      },
    ]);
    // The saved text is the baseline now, so Save again sends nothing.
    await save();
    expect(core.writes()).toEqual(['core.workspace.instructions.update']);
  });

  it('renames before it saves instructions, and a refused instructions save shows why without resending the rename', async () => {
    const core = new FakeWebCore();
    core.instructionsRefusal = true;
    const order: string[] = [];
    const onUpdateProject = jest.fn((patch: { name?: string }) => {
      order.push(`rename:${patch.name ?? ''}`);
      return SAVED();
    });
    await render({ invoker: core, onUpdateProject });
    await type(byTestId('cloud-project-settings-name'), 'Field notes');
    await click(tab('Instructions'));
    await type(byTestId('cloud-project-settings-instructions'), 'New.');
    await save();
    expect(order).toEqual(['rename:Field notes']);
    expect(core.writes()).toEqual(['core.workspace.instructions.update']);
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      "Couldn't save the project.",
    );

    // The rename landed, so a retry sends only the instructions again.
    core.instructionsRefusal = false;
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
    expect(core.writes()).toEqual([
      'core.workspace.instructions.update',
      'core.workspace.instructions.update',
    ]);
  });

  it('a refused default plugins save re-reads their revision, keeping the draft, so the next Save names the current one', async () => {
    const core = new FakeWebCore();
    // Stored but empty defaults: Save stores them as none, as the web does.
    core.defaults = { collectionIds: [], skillRefs: [], pluginRefs: [] };
    core.pluginRefusals.push({
      ok: false,
      error: {
        kind: 'conflict',
        code: 'core.workspace.revisionConflict',
        message: 'The defaults changed.',
        retry: { kind: 'never' },
      },
    });
    const onUpdateProject = jest.fn(() => SAVED());
    await render({ invoker: core, onUpdateProject });
    await type(byTestId('cloud-project-settings-name'), 'Field notes');
    // Another client saved the defaults meanwhile.
    core.defaultsRevision = 3;
    await save();
    const pluginSaves = (): Record<string, unknown>[] =>
      core.calls
        .filter((call) => call.method === 'core.workspace.plugins.update')
        .map((call) => call.params);
    expect(pluginSaves()).toHaveLength(1);
    expect(pluginSaves()[0]).toMatchObject({
      change: { expectedDefaultPluginSelectionsRevision: 2 },
    });
    // The refusal stops the steps after it, and shows why.
    expect(onUpdateProject).not.toHaveBeenCalled();
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      "Couldn't save the project.",
    );
    // The retry names the revision the dialog re-read, then renames.
    await save();
    expect(pluginSaves()).toHaveLength(2);
    expect(pluginSaves()[1]).toMatchObject({
      change: {
        kind: 'setDefaults',
        defaultPluginSelections: null,
        expectedDefaultPluginSelectionsRevision: 3,
      },
    });
    expect(onUpdateProject).toHaveBeenCalledWith({ name: 'Field notes' }, {});
  });

  it("a refreshed name is the next Save's baseline, so saving the old name back is still sent", async () => {
    const core = new FakeWebCore();
    const onUpdateProject = jest.fn(() => SAVED());
    await render({ invoker: core, onUpdateProject });
    // Another client renamed the project; the listing refreshes the props.
    await render({ invoker: core, onUpdateProject, name: 'Renamed' });
    await type(byTestId('cloud-project-settings-name'), 'Research');
    await save();
    expect(onUpdateProject).toHaveBeenCalledWith({ name: 'Research' }, {});
  });

  it('instructions answered with warnings stay unsettled: an unchanged Save resends them until they land without warnings', async () => {
    const core = new FakeWebCore();
    core.instructionsWarnings.push(["Couldn't update the project's chats."]);
    await render({ invoker: core });
    await click(tab('Instructions'));
    await type(byTestId('cloud-project-settings-instructions'), 'Cite.');
    await save();
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      "Couldn't update the project's chats.",
    );
    const instructionSaves = (): number =>
      core.calls.filter(
        (call) => call.method === 'core.workspace.instructions.update',
      ).length;
    expect(instructionSaves()).toBe(1);
    // Nothing changed, but the warned step is resent.
    await save();
    expect(instructionSaves()).toBe(2);
    // It landed cleanly, so the next unchanged Save sends nothing.
    await save();
    expect(instructionSaves()).toBe(2);
  });

  it('keeps the open dialog and its draft when the cloud connection drops, and saves the draft once it reconnects', async () => {
    const core = new FakeWebCore();
    const updateProject = jest.fn(() => SAVED());
    const online: CloudCoworkSidebarModel = {
      status: 'online',
      rows: coreCoworkSidebarRows(
        [
          {
            key: WORKSPACE,
            workspaceId: WORKSPACE,
            name: 'Research',
            kind: 'cowork',
            ownerOrganizationId: null,
          },
        ],
        {},
        { scopeId: (id) => `web-core:${id}` },
      ),
      setCollapsed: () => undefined,
      createTask: () => Promise.reject(new Error('Not in this test.')),
      reorder: () => undefined,
      updateProject,
      deleteProject: () => Promise.resolve(),
      taskDelete: false,
    };
    const offline: CloudCoworkSidebarModel = {
      status: 'offline',
      reconnect: () => undefined,
      // Offline keeps the rows last listed (CAN-6374).
      rows: online.rows,
      setCollapsed: () => undefined,
    };
    const host = async (sidebar: CloudCoworkSidebarModel): Promise<void> => {
      await act(async () => {
        await Promise.resolve();
        root.render(
          <CloudProjectSettingsHost
            target={{ projectId: PROJECT_ID }}
            sidebar={sidebar}
            onClose={() => undefined}
            invoker={core}
          />,
        );
      });
      await settle();
    };
    await host(online);
    await type(byTestId('cloud-project-settings-name'), 'Field notes');
    await click(tab('Instructions'));
    await type(byTestId('cloud-project-settings-instructions'), 'Draft.');

    await host(offline);
    const draft = (): string =>
      (byTestId('cloud-project-settings-instructions') as HTMLTextAreaElement)
        .value;
    expect(draft()).toBe('Draft.');
    await save();
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      'the cloud is unavailable',
    );
    expect(core.writes()).toEqual([]);
    expect(updateProject).not.toHaveBeenCalled();
    expect(draft()).toBe('Draft.');

    await host(online);
    await save();
    expect(updateProject).toHaveBeenCalledWith(
      PROJECT_ID,
      {
        name: 'Field notes',
      },
      {},
    );
    expect(core.writes()).toEqual(['core.workspace.instructions.update']);
  });

  it('offers a connected account MCP server the defaults do not name yet, as a cloud chat picker does', async () => {
    const core = new FakeWebCore();
    const at = '2026-11-17T00:00:00.000Z';
    core.catalogEntries = [
      {
        entryId: 'mcp_server:linear/default',
        kind: 'mcp_server',
        name: 'Linear',
        description: '',
        source: 'remote',
        content: {
          kind: 'mcp_server',
          transport: 'http',
          commandRef: null,
          url: null,
          authIntegrationId: 'integration-1',
          connectionState: 'connected',
          selectionRef: { serverId: 'linear', configId: 'default' },
        },
        availability: 'available',
        revision: 0,
        createdAt: at,
        updatedAt: at,
      },
    ];
    await render({ invoker: core });
    await click(tab('Plugins'));
    const trigger = byTestId('remote-control-chat-plugins-button');
    if (trigger === null) throw new Error('No plugins trigger');
    await click(trigger);
    expect(byTestId('remote-control-plugins-modal')?.textContent).toContain(
      'Linear',
    );
  });

  it('keeps defaults that hold only capabilities still waiting to install: an unchanged Save sends no plugins change', async () => {
    const core = new FakeWebCore();
    core.defaults = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      unresolvedCapabilities: [
        {
          kind: 'mcp',
          sourceId: 'catalog:remote',
          catalogId: 'linear',
          name: 'Linear',
        },
      ],
    };
    await render({ invoker: core });
    await save();
    expect(core.writes()).toEqual([]);
  });

  it("masks the project's name in session replay", async () => {
    await render({ invoker: new FakeWebCore() });
    const masked = [
      ...document.querySelectorAll(`.${POSTHOG_REPLAY_MASK_CLASS}`),
    ].map((element) => element.textContent);
    expect(masked).toContain('Research');
  });

  it('a failed read shows why and never offers a blank form whose Save would clear the settings', async () => {
    const core = new FakeWebCore();
    core.readFails = true;
    await render({ invoker: core });
    expect(document.body.textContent).toContain(
      "Couldn't load project settings.",
    );
    expect(byTestId('cloud-project-settings-save')).toBeNull();
    expect(core.writes()).toEqual([]);
  });
});

describe("a cloud project's egress hosts and host settings on desktop (CAN-7053)", () => {
  const ROUTE_URL = 'https://p3000-secret-sentinel.example.dev/';

  async function typeIn(id: string, value: string): Promise<void> {
    await type(byTestId(id), value);
  }

  async function check(id: string): Promise<void> {
    const box = byTestId(id)?.querySelector('input') ?? byTestId(id);
    if (!(box instanceof HTMLInputElement)) throw new Error(`No ${id}`);
    await click(box);
  }

  it('saves canonical egress hosts with the project fields, and refuses a bad host before anything is sent', async () => {
    const core = new FakeWebCore();
    const onUpdateProject = jest.fn(
      (): Promise<CoreCoworkProjectSaved> => SAVED(),
    );
    await render({ invoker: core, onUpdateProject });
    await click(tab('Network'));
    await typeIn(
      'cloud-workspace-egress-hosts',
      'API.example.com\nexample.org, api.example.com',
    );
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
    expect(onUpdateProject).toHaveBeenCalledWith(
      {
        egressAllowedHosts: ['api.example.com', 'example.org'],
      },
      {},
    );
    // Stored now, so an unchanged Save sends nothing.
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);

    await typeIn('cloud-workspace-egress-hosts', 'https://example.com');
    await save();
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      'Enter hostnames without URLs, ports, or wildcards.',
    );
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
    expect(core.writes()).toEqual([]);
  });

  it('turns on host mode with its ports, saves ports only while host mode is on, and refuses bad ports before anything is sent', async () => {
    const core = new FakeWebCore();
    const onUpdateProject = storedUpdate(core);
    await render({ invoker: core, onUpdateProject });
    await click(tab('Host'));
    // Off: the ports field is disabled and nothing about it is saved.
    await typeIn('cloud-workspace-settings-host-ports', '9999');
    await save();
    expect(onUpdateProject).not.toHaveBeenCalled();

    await check('cloud-workspace-settings-host-enabled');
    await typeIn('cloud-workspace-settings-host-ports', '3000, 8080, 3000');
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      {
        hostModeEnabled: true,
        hostPorts: [3000, 8080],
      },
      { expectedRevision: 1 },
    );

    await typeIn('cloud-workspace-settings-host-ports', '1, 2, 3, 4, 5');
    expect(
      byTestId('cloud-workspace-settings-host-ports-error')?.textContent,
    ).toBe('At most 4 ports can be exposed.');
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
  });

  it('a host save answered with warnings resends the host fields on the next Save, as the web does', async () => {
    const core = new FakeWebCore();
    const onUpdateProject = storedUpdate(core, [
      ["The ports didn't reach the running sandbox."],
      [],
    ]);
    await render({ invoker: core, onUpdateProject });
    await click(tab('Host'));
    await check('cloud-workspace-settings-host-enabled');
    await typeIn('cloud-workspace-settings-host-ports', '3000');
    await save();
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      "The ports didn't reach the running sandbox.",
    );
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(2);
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      {
        hostModeEnabled: true,
        hostPorts: [3000],
      },
      { expectedRevision: 2 },
    );
    // Landed cleanly, so the next unchanged Save sends nothing.
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(2);
  });

  it("a warned ports save keeps the saved ports while the sandbox still declares the old ones, so the resend can't undo them", async () => {
    const core = new FakeWebCore();
    core.hostModeEnabled = true;
    core.hostPorts = [3000];
    // The running sandbox hasn't caught up: it still declares 3000.
    core.sandboxRoutes = {
      hostModeEnabled: true,
      sandboxStatus: 'running',
      declaredPorts: [3000],
      routes: [],
      expiresAt: null,
    };
    const onUpdateProject = storedUpdate(core, [
      ["The ports didn't reach the running sandbox."],
      [],
    ]);
    await render({ invoker: core, onUpdateProject });
    await click(tab('Host'));
    await typeIn('cloud-workspace-settings-host-ports', '8080');
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      { hostPorts: [8080] },
      { expectedRevision: 1 },
    );
    const field = byTestId('cloud-workspace-settings-host-ports');
    if (!(field instanceof HTMLInputElement)) throw new Error('No ports');
    // The routes were read again after the save, and the field kept 8080.
    expect(field.value).toBe('8080');
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      {
        hostModeEnabled: true,
        hostPorts: [8080],
      },
      { expectedRevision: 2 },
    );
  });

  it('after a stale refusal whose reload fails, Save sends nothing until a reload lands, and then shows what is stored', async () => {
    const core = new FakeWebCore();
    core.egressAllowedHosts = ['old.example.com'];
    const onUpdateProject = jest.fn(
      (): Promise<CoreCoworkProjectSaved> =>
        Promise.reject<CoreCoworkProjectSaved>(
          new CoreCoworkRequestError({
            kind: 'conflict',
            code: 'core.workspace.revisionConflict',
            message: 'The project changed.',
            retry: { kind: 'after_refresh', resource: 'core.workspace' },
          }),
        ),
    );
    await render({ invoker: core, onUpdateProject });
    await click(tab('Network'));
    core.egressAllowedHosts = ['web.example.com'];
    core.readFails = true;
    await typeIn('cloud-workspace-egress-hosts', 'desktop.example.com');
    await save();
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      "These settings changed somewhere else and couldn't be reloaded, so this Save wasn't sent.",
    );
    // The listing has moved on, but the stale draft still isn't sent.
    onUpdateProject.mockImplementation(() => SAVED());
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);

    core.readFails = false;
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      "These settings changed somewhere else, so this Save wasn't sent.",
    );
    const field = byTestId('cloud-workspace-egress-hosts');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('No field');
    expect(field.value).toBe('web.example.com');
    // Now reloaded, an unchanged Save sends nothing either.
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
  });

  it("pins the revision of its own read: a stale sandbox save is refused by the web core's revision, reloads, and the next save names the new one", async () => {
    const core = new FakeWebCore();
    core.revision = 3;
    core.egressAllowedHosts = ['old.example.com'];
    // The web core's update: refused at any other revision; a save that
    // lands stores the hosts and moves the revision, as it now does for
    // sandbox settings.
    const onUpdateProject = jest.fn(
      (
        patch: { readonly egressAllowedHosts?: readonly string[] },
        options: { readonly expectedRevision?: number },
      ): Promise<CoreCoworkProjectSaved> => {
        if (options.expectedRevision !== core.revision)
          return Promise.reject(
            new CoreCoworkRequestError({
              kind: 'conflict',
              code: 'core.workspace.revisionConflict',
              message: 'The project changed.',
              retry: { kind: 'never' },
            }),
          );
        if (patch.egressAllowedHosts !== undefined)
          core.egressAllowedHosts = [...patch.egressAllowedHosts];
        core.revision = (core.revision ?? 0) + 1;
        return SAVED([], core.revision);
      },
    );
    await render({ invoker: core, onUpdateProject });
    await click(tab('Network'));
    // The web saves its hosts while the dialog is open: revision 4.
    core.egressAllowedHosts = ['web.example.com'];
    core.revision = 4;

    await typeIn('cloud-workspace-egress-hosts', 'desktop.example.com');
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      { egressAllowedHosts: ['desktop.example.com'] },
      { expectedRevision: 3 },
    );
    expect(core.egressAllowedHosts).toEqual(['web.example.com']);
    const field = byTestId('cloud-workspace-egress-hosts');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('No field');
    expect(field.value).toBe('web.example.com');

    // Reloaded at 4, a deliberate edit lands, and the next names 5.
    await typeIn('cloud-workspace-egress-hosts', 'desktop.example.com');
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      { egressAllowedHosts: ['desktop.example.com'] },
      { expectedRevision: 4 },
    );
    expect(core.egressAllowedHosts).toEqual(['desktop.example.com']);
    await typeIn('cloud-workspace-egress-hosts', 'next.example.com');
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      { egressAllowedHosts: ['next.example.com'] },
      { expectedRevision: 5 },
    );
    expect(onUpdateProject).toHaveBeenCalledTimes(3);
  });

  it("a save answered with a revision another save also moved reloads what is stored, so a warned resend can't turn Host back on", async () => {
    const core = new FakeWebCore();
    core.revision = 1;
    const onUpdateProject = jest.fn(
      (
        patch: CoreCoworkProjectPatch,
        options: { readonly expectedRevision?: number },
      ): Promise<CoreCoworkProjectSaved> => {
        if (options.expectedRevision !== core.revision)
          return Promise.reject(STALE());
        if (patch.hostModeEnabled !== undefined)
          core.hostModeEnabled = patch.hostModeEnabled;
        if (patch.hostPorts !== undefined)
          core.hostPorts = [...patch.hostPorts];
        core.revision = (core.revision ?? 0) + 1;
        // The web turns Host off between the desktop's write and the web
        // core's read-back, which answers that later revision.
        if (onUpdateProject.mock.calls.length === 1) {
          core.hostModeEnabled = false;
          core.hostPorts = [];
          core.revision += 1;
          return SAVED(
            ["The ports didn't reach the running sandbox."],
            core.revision,
          );
        }
        return SAVED([], core.revision);
      },
    );
    await render({ invoker: core, onUpdateProject });
    await click(tab('Host'));
    await check('cloud-workspace-settings-host-enabled');
    await typeIn('cloud-workspace-settings-host-ports', '3000');
    await save();
    expect(onUpdateProject).toHaveBeenCalledWith(
      { hostModeEnabled: true, hostPorts: [3000] },
      { expectedRevision: 1 },
    );
    // Revision 3 isn't the save's own 2: the dialog shows what is stored.
    const enabled = byTestId('cloud-workspace-settings-host-enabled');
    const box = enabled?.querySelector('input') ?? enabled;
    if (!(box instanceof HTMLInputElement)) throw new Error('No checkbox');
    expect(box.checked).toBe(false);

    // The warned step's resend carries the stored values, never Host on.
    await save();
    for (const [patch] of onUpdateProject.mock.calls.slice(1))
      expect(patch.hostModeEnabled).not.toBe(true);
    expect(core.hostModeEnabled).toBe(false);
  });

  it("takes the ports only from the stored settings: a lagging sandbox's routes never replace them, even after a conflict reload", async () => {
    const core = new FakeWebCore();
    core.hostModeEnabled = true;
    core.hostPorts = [3000];
    // The running sandbox lags: it keeps declaring 3000 throughout.
    core.sandboxRoutes = {
      hostModeEnabled: true,
      sandboxStatus: 'running',
      declaredPorts: [3000],
      routes: [],
      expiresAt: null,
    };
    const onUpdateProject = storedUpdate(core, [
      ["The ports didn't reach the running sandbox."],
    ]);
    await render({ invoker: core, onUpdateProject });
    await click(tab('Host'));
    await typeIn('cloud-workspace-settings-host-ports', '8080');
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      { hostPorts: [8080] },
      { expectedRevision: 1 },
    );

    // The web saves other ports; the warned retry is refused as stale and
    // reloads them, and the routes are read again from the lagging sandbox.
    core.hostPorts = [9000];
    core.revision = 3;
    await save();
    const field = byTestId('cloud-workspace-settings-host-ports');
    if (!(field instanceof HTMLInputElement)) throw new Error('No ports');
    expect(field.value).toBe('9000');

    // The next Save carries the web's ports at the reloaded revision, never
    // the sandbox's 3000.
    await save();
    expect(onUpdateProject).toHaveBeenLastCalledWith(
      { hostModeEnabled: true, hostPorts: [9000] },
      { expectedRevision: 3 },
    );
    for (const [patch] of onUpdateProject.mock.calls)
      expect(patch.hostPorts).not.toEqual([3000]);
    expect(core.hostPorts).toEqual([9000]);
  });

  it('a routes read that succeeds after an earlier failure shows the URLs, not the failure', async () => {
    const core = new FakeWebCore();
    core.hostModeEnabled = true;
    core.hostPorts = [3000];
    // The first read fails.
    core.sandboxRoutes = null;
    const onUpdateProject = jest.fn(
      (): Promise<CoreCoworkProjectSaved> => SAVED(),
    );
    await render({ invoker: core, onUpdateProject });
    await click(tab('Host'));
    expect(
      byTestId('cloud-workspace-settings-host-routes-warning'),
    ).not.toBeNull();
    core.sandboxRoutes = {
      hostModeEnabled: true,
      sandboxStatus: 'running',
      declaredPorts: [3000, 8080],
      routes: [{ port: 8080, url: 'https://p8080.example.dev/' }],
      expiresAt: null,
    };
    await typeIn('cloud-workspace-settings-host-ports', '3000, 8080');
    await save();
    expect(onUpdateProject).toHaveBeenCalledWith(
      { hostPorts: [3000, 8080] },
      {},
    );
    expect(byTestId('cloud-workspace-settings-host-routes-warning')).toBeNull();
    expect(
      byTestId('cloud-workspace-settings-host-route-8080')?.getAttribute(
        'href',
      ),
    ).toBe('https://p8080.example.dev/');
  });

  it("a stale revision is refused, the stored settings reload, and a concurrent web edit to the egress hosts isn't overwritten", async () => {
    const core = new FakeWebCore();
    core.egressAllowedHosts = ['old.example.com'];
    const onUpdateProject = jest.fn(
      (): Promise<CoreCoworkProjectSaved> =>
        Promise.reject<CoreCoworkProjectSaved>(
          new CoreCoworkRequestError({
            kind: 'conflict',
            code: 'core.workspace.revisionConflict',
            message: 'The project changed.',
            retry: { kind: 'after_refresh', resource: 'core.workspace' },
          }),
        ),
    );
    await render({ invoker: core, onUpdateProject });
    await click(tab('Network'));
    // Meanwhile the web saves different hosts.
    core.egressAllowedHosts = ['web.example.com'];
    await typeIn('cloud-workspace-egress-hosts', 'desktop.example.com');
    await save();
    expect(onUpdateProject).toHaveBeenCalledWith(
      {
        egressAllowedHosts: ['desktop.example.com'],
      },
      {},
    );
    expect(byTestId('cloud-project-settings-error')?.textContent).toContain(
      "These settings changed somewhere else, so this Save wasn't sent.",
    );
    // The form now shows what the web stored, not the stale draft.
    const field = byTestId('cloud-workspace-egress-hosts');
    if (!(field instanceof HTMLTextAreaElement)) throw new Error('No field');
    expect(field.value).toBe('web.example.com');
    // A Save straight after sends no egress change: the web's edit stands.
    onUpdateProject.mockImplementation(() => SAVED());
    await save();
    expect(onUpdateProject).toHaveBeenCalledTimes(1);
  });

  it('shows the live forwarded URLs only while host mode is stored on, and keeps them out of storage, logs and error reports', async () => {
    const core = new FakeWebCore();
    core.hostModeEnabled = true;
    core.hostPorts = [3000];
    core.sandboxRoutes = {
      hostModeEnabled: true,
      sandboxStatus: 'running',
      declaredPorts: [3000],
      routes: [{ port: 3000, url: ROUTE_URL }],
      expiresAt: null,
    };
    const setItem = jest.spyOn(Storage.prototype, 'setItem');
    const report = jest.spyOn(instrumentation, 'reportClientAppError');
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (level) => jest.spyOn(console, level).mockImplementation(() => undefined),
    );
    try {
      await render({ invoker: core });
      await click(tab('Host'));
      const link = byTestId('cloud-workspace-settings-host-route-3000');
      expect(link?.getAttribute('href')).toBe(ROUTE_URL);
      // Session replay records nothing inside the routes list: no text, no
      // href, no click.
      expect(link?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBe(
        byTestId('cloud-workspace-settings-host-routes-list'),
      );
      // Refresh reads again.
      const before = core.calls.filter(
        (call) => call.method === 'core.workspace.sandboxRoutes.get',
      ).length;
      const refresh = byTestId('cloud-workspace-settings-host-routes-refresh');
      if (!(refresh instanceof HTMLElement)) throw new Error('No refresh');
      await click(refresh);
      expect(
        core.calls.filter(
          (call) => call.method === 'core.workspace.sandboxRoutes.get',
        ).length,
      ).toBe(before + 1);
      const leaked = [
        ...setItem.mock.calls,
        ...report.mock.calls,
        ...logs.flatMap((spy) => spy.mock.calls),
      ].filter((call) => JSON.stringify(call).includes('secret-sentinel'));
      expect(leaked).toEqual([]);
    } finally {
      setItem.mockRestore();
      report.mockRestore();
      for (const spy of logs) spy.mockRestore();
    }
  });

  it('hides the URLs while host mode is stored off, and says when the sandbox could not be checked', async () => {
    const core = new FakeWebCore();
    await render({ invoker: core });
    await click(tab('Host'));
    expect(byTestId('cloud-workspace-settings-host-routes')).toBeNull();

    const failing = new FakeWebCore();
    failing.hostModeEnabled = true;
    await render({ invoker: failing });
    await click(tab('Host'));
    expect(
      byTestId('cloud-workspace-settings-host-routes-warning'),
    ).not.toBeNull();
  });

  it("renders the web's Network and Host tabs: the same shared components, the same markup", async () => {
    const core = new FakeWebCore();
    core.hostModeEnabled = true;
    core.hostPorts = [3000];
    core.egressAllowedHosts = ['api.example.com'];
    core.sandboxRoutes = {
      hostModeEnabled: true,
      sandboxStatus: 'running',
      declaredPorts: [3000],
      routes: [{ port: 3000, url: 'https://p3000.example.dev/' }],
      expiresAt: null,
    };
    await render({ invoker: core });
    // Element ids are per render; everything else must match.
    const normalize = (html: string | undefined): string =>
      (html ?? '').replace(/ (?:id|for|aria-describedby)="[^"]*"/g, '');
    await click(tab('Network'));
    const desktopNetwork = byTestId('cloud-workspace-egress-hosts')?.closest(
      '[role="tabpanel"]',
    )?.innerHTML;
    await click(tab('Host'));
    const desktopHost = byTestId(
      'cloud-workspace-settings-host-enabled',
    )?.closest('[role="tabpanel"]')?.innerHTML;

    const shared = document.createElement('div');
    document.body.append(shared);
    const sharedRoot = createRoot(shared);
    await act(async () => {
      await Promise.resolve();
      sharedRoot.render(
        <>
          <div data-tab="network">
            <CloudProjectNetworkTab
              fieldId="f"
              value="api.example.com"
              onChange={() => undefined}
            />
          </div>
          <div data-tab="host">
            <CloudProjectHostTab
              hostModeEnabled
              onHostModeChange={() => undefined}
              portsFieldId="p"
              portsText="3000"
              onPortsTextChange={() => undefined}
              portsError={null}
              routesVisible
              routes={{
                state: 'ready',
                routes: [{ port: 3000, url: 'https://p3000.example.dev/' }],
                expiresAtMs: null,
              }}
              onRefreshRoutes={() => undefined}
            />
          </div>
        </>,
      );
    });
    // The desktop panel wraps the shared tab in its own layout; the tab's
    // markup inside is the web's, byte for byte.
    const sharedNetwork = normalize(
      shared.querySelector('[data-tab="network"]')?.innerHTML,
    );
    const sharedHost = normalize(
      shared.querySelector('[data-tab="host"]')?.innerHTML,
    );
    expect(sharedNetwork.length).toBeGreaterThan(100);
    expect(sharedHost.length).toBeGreaterThan(100);
    expect(normalize(desktopNetwork)).toContain(sharedNetwork);
    expect(normalize(desktopHost)).toContain(sharedHost);
    act(() => sharedRoot.unmount());
    shared.remove();
  });
});
