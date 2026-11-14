/** @jest-environment jsdom */
/**
 * A desktop cloud chat's picker offers this computer's skills and plugins
 * the cloud account lacks (CAN-6176): each is added only through the host's
 * own flow, and the cloud copy it returns is ticked in the draft, so Save
 * selects it. Nothing is offered without the seam, as on the web.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PortalChatTabPluginSelections,
  PortalPluginCatalog,
} from '@canopy/protocol/portal';
import {
  PortalPluginsPicker,
  type PortalPluginsLocalItemsSeam,
} from '../PortalPluginsPicker';

(
  globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const CLOUD_COPY = { sourceId: 'cloud-custom', skillName: 'skill-77' };

const CATALOG: PortalPluginCatalog = {
  collections: [],
  skills: [
    {
      ...CLOUD_COPY,
      name: 'notes',
      description: 'Take notes.',
      source: 'My skills',
    },
  ],
  plugins: [],
  mcpServers: [],
};

const NONE: PortalChatTabPluginSelections = {
  collectionIds: [],
  skillRefs: [],
  pluginRefs: [],
};

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
  document.body.innerHTML = '';
});

function render(options: {
  localItems?: PortalPluginsLocalItemsSeam;
  onChange?: (next: PortalChatTabPluginSelections) => Promise<void>;
}): void {
  act(() => {
    root.render(
      <PortalPluginsPicker
        open
        hideTrigger
        catalog={CATALOG}
        selections={NONE}
        brandDisplayName="Canopy"
        onChange={options.onChange ?? ((): Promise<void> => Promise.resolve())}
        {...(options.localItems === undefined
          ? {}
          : { localItems: options.localItems })}
      />,
    );
  });
}

const byTestId = (id: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

describe('this computer’s items in the cloud picker (CAN-6176)', () => {
  it('lists them with Add to cloud, or Update in cloud for an older copy', () => {
    render({
      localItems: {
        items: [
          {
            key: 'skill:custom/notes',
            name: 'notes',
            kind: 'skill',
            replacing: false,
          },
          {
            key: 'plugin:local/tools',
            name: 'tools',
            kind: 'plugin',
            replacing: true,
          },
        ],
        onAdd: () => Promise.resolve(null),
      },
    });
    const items = byTestId('portal-plugins-local-item');
    expect(items.map((item) => item.textContent)).toEqual([
      'notesSkillAdd to cloud',
      'toolsPluginUpdate in cloud',
    ]);
  });

  it('offers nothing without the seam, or with no items', () => {
    render({});
    expect(byTestId('portal-plugins-local-items')).toHaveLength(0);
    render({ localItems: { items: [], onAdd: () => Promise.resolve(null) } });
    expect(byTestId('portal-plugins-local-items')).toHaveLength(0);
  });

  it('ticks the cloud copy the host added, so Save selects it', async () => {
    let finish: (added: {
      skillRefs: (typeof CLOUD_COPY)[];
      pluginRefs: [];
    }) => void = () => undefined;
    const asked: string[] = [];
    const saved: PortalChatTabPluginSelections[] = [];
    render({
      localItems: {
        items: [
          {
            key: 'skill:custom/notes',
            name: 'notes',
            kind: 'skill',
            replacing: false,
          },
        ],
        onAdd: (key) => {
          asked.push(key);
          return new Promise((resolve) => {
            finish = resolve;
          });
        },
      },
      onChange: (next) => {
        saved.push(next);
        return Promise.resolve();
      },
    });
    const [add] = byTestId('portal-plugins-local-add');
    act(() => add.click());
    expect(asked).toEqual(['skill:custom/notes']);
    // One at a time: the button waits for the host's answer.
    expect(byTestId('portal-plugins-local-add')[0]).toHaveProperty(
      'disabled',
      true,
    );
    // Save waits too: the copy isn't in the draft yet, and would be lost.
    expect(byTestId('portal-plugins-save')[0]).toHaveProperty('disabled', true);
    act(() => byTestId('portal-plugins-save')[0].click());
    expect(saved).toEqual([]);
    await act(async () => {
      finish({ skillRefs: [CLOUD_COPY], pluginRefs: [] });
      await Promise.resolve();
    });
    act(() => byTestId('portal-plugins-save')[0].click());
    expect(saved.at(-1)?.skillRefs).toEqual([CLOUD_COPY]);
  });

  it('selects nothing when the host added nothing', async () => {
    const saved: PortalChatTabPluginSelections[] = [];
    render({
      localItems: {
        items: [
          {
            key: 'skill:custom/notes',
            name: 'notes',
            kind: 'skill',
            replacing: false,
          },
        ],
        onAdd: () => Promise.resolve(null),
      },
      onChange: (next) => {
        saved.push(next);
        return Promise.resolve();
      },
    });
    await act(async () => {
      byTestId('portal-plugins-local-add')[0].click();
      await Promise.resolve();
    });
    expect(byTestId('portal-plugins-local-add')[0]).toHaveProperty(
      'disabled',
      false,
    );
    act(() => byTestId('portal-plugins-save')[0].click());
    expect(saved.at(-1)?.skillRefs ?? []).toEqual([]);
  });
});
