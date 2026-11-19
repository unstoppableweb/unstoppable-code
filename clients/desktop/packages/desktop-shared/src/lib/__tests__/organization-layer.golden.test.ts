/**
 * Organization skills and plugins for every project (CAN-6237, CAN-6240).
 * Every chat in an organization workspace resolves its plugins through
 * `effectiveChatPluginSelections`, in the session, the composer and every
 * other desktop path, so this rule decides what an agent loads: the
 * organization's shared set is inherited beside the person's own skills, and
 * an organization pick lasts only while the workspace allows it. A break
 * loads a removed item everywhere, leaks one project's items into another,
 * or drops a person's own skills.
 */
import {
  effectiveChatPluginSelections,
  organizationLayersFor,
  splitChosenChatPluginSelections,
} from '../effective-plugin-selections';
import {
  organizationLayerItems,
  organizationLayerSelections,
  parseOrganizationLayerView,
  withSelectionOwnersRestored,
  type OrganizationLayerView,
  organizationSkillSourceId,
  withOnlyAllowedOrganizationRefs,
  type AllowedOrganizationItems,
  type OrganizationCapabilitySnapshot,
} from '../organization-capabilities';
import type { ChatTabPluginSelections } from '../../types';

const ORG = 'org-acme';
const owner = { type: 'organization' as const, organizationId: ORG };
const source = organizationSkillSourceId(ORG);

const snapshot = (
  items: OrganizationCapabilitySnapshot['items'],
): OrganizationCapabilitySnapshot => ({
  scope: { organizationId: ORG, projectId: 'project-web' },
  accountId: 'account-1',
  setupRevision: 1,
  defaultsRevision: 1,
  fetchedAt: 0,
  items,
});

const REVIEW = {
  key: 'skill:review',
  name: 'Review',
  source: 'organization' as const,
  status: 'installed' as const,
  skillRef: { sourceId: source, skillName: 'review-11111111' },
};
const LINT = {
  key: 'plugin:lint',
  name: 'Lint',
  source: 'project' as const,
  status: 'installed' as const,
  pluginRef: { marketplaceId: 'acme-market', pluginName: 'lint' },
};
const PERSONAL = { sourceId: 'custom:app', skillName: 'my-notes' };

function layerOf(items: OrganizationCapabilitySnapshot['items']): {
  layer: ChatTabPluginSelections;
  allowed: AllowedOrganizationItems;
} {
  const layer = organizationLayerSelections(snapshot(items));
  return { layer, allowed: { organizationId: ORG, selections: layer } };
}

describe('the organization layer (CAN-6237, CAN-6240)', () => {
  it('a chat inherits the shared set beside the person’s own skills', () => {
    const { layer, allowed } = layerOf([
      REVIEW,
      LINT,
      {
        key: 'agent:x',
        name: 'X',
        source: 'organization',
        status: 'unsupported',
      },
    ]);
    const effective = effectiveChatPluginSelections({
      local: undefined,
      global: { collectionIds: [], skillRefs: [PERSONAL], pluginRefs: [] },
      organization: layer,
      allowedOrganizationItems: allowed,
    });
    expect(effective.skillRefs).toEqual([
      PERSONAL,
      { ...REVIEW.skillRef, owner },
    ]);
    expect(effective.pluginRefs).toEqual([{ ...LINT.pluginRef, owner }]);
  });

  it('an item removed from the project stops on the next resolution', () => {
    const pick = { ...REVIEW.skillRef, owner };
    const before = layerOf([REVIEW]);
    expect(
      effectiveChatPluginSelections({
        local: { collectionIds: [], skillRefs: [pick], pluginRefs: [] },
        organization: before.layer,
        allowedOrganizationItems: before.allowed,
      }).skillRefs,
    ).toEqual([pick]);
    const after = layerOf([]);
    expect(
      effectiveChatPluginSelections({
        local: {
          collectionIds: [],
          skillRefs: [pick, PERSONAL],
          pluginRefs: [],
        },
        organization: after.layer,
        allowedOrganizationItems: after.allowed,
      }).skillRefs,
    ).toEqual([PERSONAL]);
  });

  it('a chat moved to another organization or a Personal workspace loses its picks', () => {
    const pick = { ...REVIEW.skillRef, owner };
    const local = {
      collectionIds: [],
      skillRefs: [pick, PERSONAL],
      pluginRefs: [],
    };
    const other = organizationLayerSelections({
      ...snapshot([REVIEW]),
      scope: { organizationId: 'org-globex', projectId: null },
    });
    expect(
      effectiveChatPluginSelections({
        local,
        allowedOrganizationItems: {
          organizationId: 'org-globex',
          selections: other,
        },
      }).skillRefs,
    ).toEqual([PERSONAL]);
    expect(effectiveChatPluginSelections({ local }).skillRefs).toEqual([
      PERSONAL,
    ]);
  });

  it('a chat that opted out of defaults gets a shared item only by its own pick', () => {
    const { allowed } = layerOf([REVIEW, LINT]);
    const pick = { ...LINT.pluginRef, owner };
    const effective = effectiveChatPluginSelections({
      local: { collectionIds: [], skillRefs: [], pluginRefs: [pick] },
      allowedOrganizationItems: allowed,
    });
    expect(effective.skillRefs).toEqual([]);
    expect(effective.pluginRefs).toEqual([pick]);
  });

  it('a chat can switch an inherited item off, and only that one', () => {
    const { layer, allowed } = layerOf([REVIEW, LINT]);
    const effective = effectiveChatPluginSelections({
      local: undefined,
      organization: layer,
      allowedOrganizationItems: allowed,
      chatTombstones: { skillRefs: [{ ...REVIEW.skillRef, owner }] },
    });
    expect(effective.skillRefs).toEqual([]);
    expect(effective.pluginRefs).toEqual([{ ...LINT.pluginRef, owner }]);
  });

  it('a ref to an organization skill copy without its owner is never loaded', () => {
    const { allowed } = layerOf([REVIEW]);
    const { selections, dropped } = withOnlyAllowedOrganizationRefs(
      {
        collectionIds: [],
        skillRefs: [REVIEW.skillRef, PERSONAL],
        pluginRefs: [],
      },
      allowed,
    );
    expect(selections.skillRefs).toEqual([PERSONAL]);
    expect(dropped.skillRefs).toEqual([REVIEW.skillRef]);
  });

  it('a picker save keeps the organization items and the person’s own picks apart', () => {
    const { layer } = layerOf([REVIEW, LINT]);
    const view: OrganizationLayerView = {
      organizationId: ORG,
      layer,
      items: organizationLayerItems(snapshot([REVIEW, LINT])),
    };
    // What main sends the renderer survives its own check.
    expect(parseOrganizationLayerView(view)).toEqual(view);
    expect(parseOrganizationLayerView({ ...view, organizationId: '' })).toBe(
      null,
    );
    const layers = organizationLayersFor(view, true);
    const local = {
      collectionIds: [],
      skillRefs: [PERSONAL],
      pluginRefs: [LINT.pluginRef],
    };
    const shown = effectiveChatPluginSelections({ local, ...layers });
    // The picker keys rows by identity, so its save has no owners; the
    // person unchecks the shared skill.
    const chosen = withSelectionOwnersRestored(
      {
        collectionIds: [],
        skillRefs: [PERSONAL],
        pluginRefs: [LINT.pluginRef],
      },
      { previous: shown, organization: view },
    );
    const { localSelections, tombstones } = splitChosenChatPluginSelections({
      chosen,
      ...layers,
      previousLocal: local,
    });
    // The person's own pick of the plugin stays theirs, and the shared skill
    // is switched off for this chat only.
    expect(localSelections.skillRefs).toEqual([PERSONAL]);
    expect(localSelections.pluginRefs).toEqual([LINT.pluginRef]);
    expect(tombstones.skillRefs).toEqual([{ ...REVIEW.skillRef, owner }]);
    const after = effectiveChatPluginSelections({
      local: localSelections,
      chatTombstones: tombstones,
      ...layers,
    });
    expect(after.skillRefs).toEqual([PERSONAL]);
    // A chat that does not inherit still may use what the layer allows.
    expect(organizationLayersFor(view, false)).toEqual({
      allowedOrganizationItems: { organizationId: ORG, selections: layer },
    });
    expect(organizationLayersFor(null, true)).toEqual({});
  });
});
