import {
  EXPERIMENT_ACTION_TYPES,
  INSTALLED_ITEM_ACTION_TYPES,
  PIPELINES_ACTION_TYPES,
  SETTINGS_ACTION_TYPES,
  TRANSCRIPT_READ_ACTION_TYPES,
} from '@canopy/agent-actions';
import { CanopyGrantNameSchema } from '@canopy/protocol/canopy-core';
import {
  APP_ADVISOR_ACTION_DISPOSITIONS,
  APP_ADVISOR_ACTION_GRANTS,
  APP_ADVISOR_PRESENTATION_ACTION_TYPES,
  type AppAdvisorActionDisposition,
} from '../app-advisor-action-dispositions';
import { APP_ADVISOR_ACTION_CATALOG } from '../app-advisor-actions';

/** Every type DispatchAction accepts: the catalog, transcript reads and the shared-engine families. */
const DISPATCH_ACTION_TYPES = [
  ...new Set([
    ...APP_ADVISOR_ACTION_CATALOG.map((entry) => entry.type),
    ...TRANSCRIPT_READ_ACTION_TYPES,
    ...INSTALLED_ITEM_ACTION_TYPES,
    ...EXPERIMENT_ACTION_TYPES,
    ...SETTINGS_ACTION_TYPES,
    ...PIPELINES_ACTION_TYPES,
  ]),
].sort();

const entries = Object.entries(APP_ADVISOR_ACTION_DISPOSITIONS);

function count(
  predicate: (disposition: AppAdvisorActionDisposition) => boolean,
): number {
  return entries.filter(([, disposition]) => predicate(disposition)).length;
}

function writeGrants(
  disposition: AppAdvisorActionDisposition,
): readonly string[] {
  if (disposition.kind === 'core' && disposition.access === 'write')
    return disposition.grants;
  if (disposition.kind === 'legacy' && disposition.access === 'write')
    return disposition.grants;
  return [];
}

describe('App Advisor action dispositions (CAN-4133)', () => {
  it('every App Advisor action type has exactly one disposition', () => {
    expect(Object.keys(APP_ADVISOR_ACTION_DISPOSITIONS).sort()).toEqual(
      DISPATCH_ACTION_TYPES,
    );
  });

  it('the totals match the specification', () => {
    expect({
      coreWrites: count((d) => d.kind === 'core' && d.access === 'write'),
      coreReads: count((d) => d.kind === 'core' && d.access === 'read'),
      hostPresentation: count((d) => d.kind === 'host_presentation'),
      presentation: count((d) => d.kind === 'presentation'),
      legacyWrites: count((d) => d.kind === 'legacy' && d.access === 'write'),
      legacyReads: count((d) => d.kind === 'legacy' && d.access === 'read'),
    }).toEqual({
      coreWrites: 180,
      coreReads: 115,
      hostPresentation: 3,
      presentation: 91,
      legacyWrites: 37,
      legacyReads: 9,
    });
  });

  it("the grant set is exactly the union of the writes' grants", () => {
    const union = [
      ...new Set(
        entries.flatMap(([, disposition]) => writeGrants(disposition)),
      ),
    ].sort();
    expect(union).toEqual([...APP_ADVISOR_ACTION_GRANTS]);
    for (const grant of APP_ADVISOR_ACTION_GRANTS)
      expect(CanopyGrantNameSchema.safeParse(grant).success).toBe(true);
  });

  it('no write names an approval, vault, client or workspace-record grant', () => {
    const forbidden = [
      'core.approval.',
      'core.vault.',
      'core.client.',
      'core.workspaceRecords.',
    ];
    const grants = entries.flatMap(([, disposition]) =>
      writeGrants(disposition),
    );
    expect(
      grants.filter((grant) =>
        forbidden.some((prefix) => grant.startsWith(prefix)),
      ),
    ).toEqual([]);
  });

  it('the presentation set equals the presentation dispositions', () => {
    expect([...APP_ADVISOR_PRESENTATION_ACTION_TYPES].sort()).toEqual(
      entries
        .filter(([, disposition]) => disposition.kind === 'presentation')
        .map(([type]) => type)
        .sort(),
    );
  });

  // These act on a visible surface but change hosted connections, so a move of
  // that surface must not turn them into presentation (CAN-5765).
  it('the account MCP actions stay integration writes, not presentation', () => {
    for (const type of [
      'mcp.account_connect',
      'mcp.account_reconnect',
      'mcp.account_disconnect',
      'mcp.account_promote',
      'mcp.account_edit',
    ] as const)
      // CAN-6008 B1: main hands them to the surface, keyed, with the lease bound.
      expect(APP_ADVISOR_ACTION_DISPOSITIONS[type]).toEqual({
        kind: 'core',
        access: 'write',
        executor: 'settings-surface',
        grants: ['core.integration.write'],
        revision: 'none',
        requiresInterface: true,
      });
  });

  it('only the two composite types are composite, and only open_tab is presentation with a chatId', () => {
    const composite = entries
      .filter(
        ([, d]) => d.kind === 'core' && d.access === 'write' && d.composite,
      )
      .map(([type]) => type)
      .sort();
    const presentationWhenChatId = entries
      .filter(
        ([, d]) =>
          d.kind === 'core' && d.access === 'write' && d.presentationWhenChatId,
      )
      .map(([type]) => type);
    expect(composite).toEqual([
      'standalone-chat.create_chat',
      'worktree-chat.open_tab',
    ]);
    expect(presentationWhenChatId).toEqual(['worktree-chat.open_tab']);
  });
});
