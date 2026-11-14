import { isActivitySectionVisibleForTarget } from '@canopy/app-state';
import {
  CORE_ARTIFACT_QUERY_DEFINITIONS,
  type CoreArtifact,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyCoreRelayApi,
  CanopyCoreRelayReply,
  CanopyCoreRelayRequest,
} from '../../../../shared/canopy-core-relay';
import { createDesktopCapabilities } from '@/client/ipc-canopy-client';
import {
  projectServesActivitySection,
  scopeServesActivitySection,
} from '@/lib/panels/scope-panel-kinds';
import { webCoreScopeCapabilities } from '@/lib/web-core-scope-capabilities';
import {
  cloudWorkspaceFileList,
  cloudWorkspaceFilesHeader,
  refreshCloudWorkspaceFiles,
} from '../cloud-workspace-file-list';

// A cloud task's Activity on desktop (CAN-6568): its project's shared
// workspace files show, read from the web core, so a task with files but no
// todos or background work no longer reads "No activity yet". A cloud task
// has no summary yet, so its dead Summary section and Refresh are gone.

const LIST = CORE_ARTIFACT_QUERY_DEFINITIONS['core.artifact.list'];
const WORKSPACE = '11111111-1111-4111-8111-111111111111';

const desktop = createDesktopCapabilities('darwin', {}, {});
const cloud = webCoreScopeCapabilities(desktop);

function file(name: string, extra: Partial<CoreArtifact> = {}): CoreArtifact {
  return {
    artifactId: `wsf:${WORKSPACE}:${name}`,
    owner: { kind: 'workspace', id: WORKSPACE },
    kind: 'file',
    name,
    mediaType: 'text/csv',
    sizeBytes: 2048,
    sha256: 'a'.repeat(64),
    createdAt: '2026-11-12T12:00:00.000Z',
    availability: 'available',
    transfer: null,
    ...extra,
  };
}

/** A request's params; every relay request this test sees has them. */
function paramsOf(request: CanopyCoreRelayRequest | undefined): unknown {
  return request !== undefined && 'params' in request
    ? request.params
    : undefined;
}

function relayAnswering(
  answer: (request: CanopyCoreRelayRequest) => CanopyCoreRelayReply,
): CanopyCoreRelayApi & { readonly requests: CanopyCoreRelayRequest[] } {
  const requests: CanopyCoreRelayRequest[] = [];
  return {
    requests,
    invoke: (request) => {
      requests.push(request);
      return Promise.resolve(answer(request));
    },
  };
}

describe("a cloud task's Activity on desktop (CAN-6568)", () => {
  it('serves Workspace files on a cloud scope only, and Summary on a local scope only', () => {
    expect(scopeServesActivitySection(cloud, 'workspace-files')).toBe(true);
    // An unset allowlist means every section a local workspace shows; this
    // one reads a cloud project, so it is never among them.
    expect(scopeServesActivitySection(desktop, 'workspace-files')).toBe(false);
    expect(isActivitySectionVisibleForTarget('summary', 'cowork', cloud)).toBe(
      false,
    );
    expect(
      isActivitySectionVisibleForTarget('summary', 'cowork', desktop),
    ).toBe(true);
  });

  it("lists the project's available workspace files over the web core", async () => {
    const relay = relayAnswering((request) => {
      expect(request).toMatchObject({
        kind: 'request',
        method: 'core.artifact.list',
        authority: 'web-core',
      });
      expect(LIST.params.safeParse(paramsOf(request)).error).toBeUndefined();
      const value = {
        artifacts: [
          file('ericeira_weather.csv'),
          file('old.csv', { availability: 'deleted' }),
        ],
        nextCursor: null,
      };
      expect(LIST.result.safeParse(value).error).toBeUndefined();
      return { ok: true, value };
    });
    await refreshCloudWorkspaceFiles(relay, WORKSPACE);
    expect(paramsOf(relay.requests[0])).toMatchObject({
      owner: { kind: 'workspace', id: WORKSPACE },
      states: ['available'],
    });
    expect(cloudWorkspaceFileList(WORKSPACE)).toEqual({
      kind: 'ready',
      rows: [
        {
          id: `wsf:${WORKSPACE}:ericeira_weather.csv`,
          name: 'ericeira_weather.csv',
          sizeBytes: 2048,
          createdAt: '2026-11-12T12:00:00.000Z',
        },
      ],
    });
  });

  it('leaves the section out where the web core serves no workspace files', async () => {
    const other = '22222222-2222-4222-8222-222222222222';
    const relay = relayAnswering(() => ({
      ok: false,
      error: {
        kind: 'capability_unavailable',
        message: 'This core does not serve owner.kind.',
        details: { option: 'owner.kind' },
        retry: { kind: 'after_refresh', resource: 'core.runtime.manifest' },
      },
    }));
    await refreshCloudWorkspaceFiles(relay, other);
    expect(cloudWorkspaceFileList(other)).toEqual({ kind: 'unavailable' });
    // Never offered, restored or mounted there, nor counted in the rail.
    expect(
      projectServesActivitySection(`web-core:${other}`, 'workspace-files'),
    ).toBe(false);
    expect(projectServesActivitySection(`web-core:${other}`, 'todo')).toBe(
      true,
    );
    expect(
      projectServesActivitySection(`web-core:${WORKSPACE}`, 'workspace-files'),
    ).toBe(true);
    expect(cloudWorkspaceFilesHeader({ kind: 'unavailable' }).hasContent).toBe(
      false,
    );
  });

  it("keeps a failed read's section in the rail, so its error and Try again show", () => {
    expect(cloudWorkspaceFilesHeader({ kind: 'error' })).toMatchObject({
      hasContent: true,
    });
    expect(
      cloudWorkspaceFilesHeader({
        kind: 'ready',
        rows: [
          {
            id: 'a',
            name: 'a.csv',
            sizeBytes: 1,
            createdAt: '2026-11-12T12:00:00.000Z',
          },
          {
            id: 'b',
            name: 'b.csv',
            sizeBytes: 1,
            createdAt: '2026-11-12T12:00:00.000Z',
          },
        ],
      }),
    ).toEqual({
      subtitle: '2 files',
      collapsedIconColor: 'blue',
      hasContent: true,
    });
    expect(
      cloudWorkspaceFilesHeader({ kind: 'ready', rows: [] }).hasContent,
    ).toBe(false);
  });
});
