import type { AccountOrganizationSettingsClient } from '@canopy/app-core/settings';
import type { OrganizationConnection } from '@canopy/protocol/canopy-core';

/** An organization project as the Projects dialog lists it. */
export interface ConnectionProject {
  readonly id: string;
  readonly name: string;
}

/**
 * Where a connection is used: every project (an organization default),
 * only the projects chosen for it, or none yet.
 */
export type ConnectionProjectsMode = 'every' | 'chosen';

export type ConnectionProjectsSummary =
  | {
      readonly kind: 'every';
      /**
       * Projects that switched the default off; empty when none did, and
       * undefined from a server that doesn't say.
       */
      readonly excluded: readonly ConnectionProject[] | undefined;
    }
  | { readonly kind: 'some'; readonly projects: readonly ConnectionProject[] }
  | { readonly kind: 'none' };

export function connectionProjectsSummary(
  connection: Pick<
    OrganizationConnection,
    'organizationDefault' | 'projects' | 'excludedProjects'
  >,
): ConnectionProjectsSummary {
  if (connection.organizationDefault)
    return { kind: 'every', excluded: connection.excludedProjects };
  return connection.projects.length > 0
    ? { kind: 'some', projects: connection.projects }
    : { kind: 'none' };
}

/**
 * The projects ticked when the dialog opens: the listed projects that use
 * the connection now. Only `projects`, the confirmed use, decides a tick;
 * `excludedProjects` is display only (it is capped, so a project missing
 * from it may still have switched a default off).
 */
export function initialChosenProjects(
  connection: Pick<OrganizationConnection, 'projects'>,
  projects: readonly ConnectionProject[],
): ReadonlySet<string> {
  const using = new Set(connection.projects.map((project) => project.id));
  return new Set(
    projects.filter((project) => using.has(project.id)).map((p) => p.id),
  );
}

/** A project this dialog changed, as the update sends it. */
export interface ConnectionProjectChange {
  readonly projectId: string;
  /** Whether the project should use it. */
  readonly use: boolean;
  /** Whether it used it when the dialog opened. */
  readonly using: boolean;
}

/**
 * The projects this dialog changed: ticked or cleared since it opened. Every
 * other project keeps its use, so a change another admin made stands.
 */
export function connectionProjectChanges(
  projects: readonly ConnectionProject[],
  chosen: ReadonlySet<string>,
  initial: ReadonlySet<string>,
): ConnectionProjectChange[] {
  return projects
    .filter((project) => chosen.has(project.id) !== initial.has(project.id))
    .map((project) => ({
      projectId: project.id,
      use: chosen.has(project.id),
      using: initial.has(project.id),
    }));
}

export interface SaveConnectionProjectsInput {
  readonly client: AccountOrganizationSettingsClient;
  readonly organizationId: string;
  readonly connectionId: string;
  /** Every project the dialog listed. */
  readonly projects: readonly ConnectionProject[];
  readonly mode: ConnectionProjectsMode;
  readonly chosen: ReadonlySet<string>;
  /** The projects that used it when the dialog opened (its first ticks). */
  readonly initial: ReadonlySet<string>;
  /** Whether it was a default when the dialog opened. */
  readonly initialDefault: boolean;
}

/**
 * Saves the dialog's choice in one update the server applies in one
 * transaction (`core.integration.sharedConnection.projects.update`): the
 * mode, and only the projects this dialog changed, each with what the
 * dialog read. If the default or one of those projects moved since, the
 * server refuses it all (`core.integration.sharedConnection.changed`).
 * Answers the connection as saved.
 */
export async function saveConnectionProjects({
  client,
  organizationId,
  connectionId,
  projects,
  mode,
  chosen,
  initial,
  initialDefault,
}: SaveConnectionProjectsInput): Promise<OrganizationConnection> {
  const saved = await client.write(
    'organization.settings.connections.projects',
    {
      organizationId,
      connectionId,
      everyProject: mode === 'every',
      expectedEveryProject: initialDefault,
      changes: connectionProjectChanges(projects, chosen, initial),
      idempotencyKey: crypto.randomUUID(),
    },
  );
  return saved.connection;
}
