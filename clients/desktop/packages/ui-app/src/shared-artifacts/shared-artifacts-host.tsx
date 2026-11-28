import { createContext, useContext, type JSX, type ReactNode } from 'react';
import type { CanopyClient, SharedArtifactsClient } from '@canopy/app-core';
import type { PdfPreviewAssets } from '@canopy/ui-rich/pdf';
import type {
  ShareNotify,
  ShareResourceAccount,
  ShareTargetSummary,
} from '../sharing';

/** What the host knows about the person viewing, from explicit account facts. */
export interface SharedArtifactViewer {
  /** Fixed at page load; a session that expires later is not noticed. */
  readonly signedIn: boolean;
  readonly userId?: string;
  readonly organizationIds: readonly string[];
}

/** How HTML and SVG artifacts reach the agent-visual sandbox. */
export interface SharedArtifactFrameHost {
  /** The shell route on a host whose page policy blocks an inline frame. */
  readonly frameUrl?: string;
  readonly remoteAssets: boolean;
  /**
   * The only way an artifact link leaves the page, for HTML, SVG and
   * markdown alike. The host checks the URL and opens it without an opener
   * or referrer.
   */
  readonly openLink: (url: string) => void;
}

/** The account ports `ShareResourceDialog` needs, for a signed-in manager. */
export interface SharedArtifactShareHost {
  readonly loadAccount: () => Promise<ShareResourceAccount | null>;
  readonly subscribeAccountChanged?: (listener: () => void) => () => void;
  readonly listTeams: (query: string) => Promise<readonly ShareTargetSummary[]>;
  readonly listOrganizations: (
    query: string,
  ) => Promise<readonly ShareTargetSummary[]>;
  readonly notify: ShareNotify;
}

/**
 * The shared artifact host port (CAN-8017). The public share page mounts no
 * `CanopyClientProvider`, so shared artifact UI reads everything it needs
 * from here and never calls `useCapabilities()` or `useCanopyClient()`.
 * Shared components never branch on host identity; a missing client or a
 * false capability renders the capability-gated state.
 */
export interface SharedArtifactsHost {
  readonly client: SharedArtifactsClient | null;
  readonly capabilities: { readonly create: boolean; readonly view: boolean };
  readonly viewer: SharedArtifactViewer;
  readonly frame: SharedArtifactFrameHost;
  readonly resolvePdfAssets: (pdfJsVersion: string) => PdfPreviewAssets;
  /** An absolute URL for a same-origin path (the share link). */
  readonly absoluteUrl: (path: string) => string;
  readonly copyText: (text: string) => Promise<boolean>;
  /**
   * The sign-in page that returns to `returnPath`. Receives only a path
   * built by `sharedArtifactSharePath` from a validated id, and encodes it.
   */
  readonly signInHref: (returnPath: string) => string;
  readonly openArtifact: (artifactId: string) => void;
  /** Absent: the share controls are not offered on this host. */
  readonly share?: SharedArtifactShareHost;
}

const SharedArtifactsHostContext = createContext<SharedArtifactsHost | null>(
  null,
);

export function SharedArtifactsHostProvider({
  host,
  children,
}: {
  readonly host: SharedArtifactsHost;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <SharedArtifactsHostContext.Provider value={host}>
      {children}
    </SharedArtifactsHostContext.Provider>
  );
}

/** The host port, or null when no host mounted one (renders unavailable). */
export function useSharedArtifactsHost(): SharedArtifactsHost | null {
  return useContext(SharedArtifactsHostContext);
}

/**
 * For a host with a full `CanopyClient` (desktop in CAN-8018): the client
 * and capabilities come from `client.sharedArtifacts` and
 * `client.capabilities.sharedArtifacts`.
 */
export function sharedArtifactsHostFromCanopyClient(
  client: Pick<CanopyClient, 'sharedArtifacts' | 'capabilities'>,
  rest: Omit<SharedArtifactsHost, 'client' | 'capabilities'>,
): SharedArtifactsHost {
  const capability = client.capabilities.sharedArtifacts;
  const sharedArtifacts = client.sharedArtifacts ?? null;
  return {
    ...rest,
    client: capability?.view === true ? sharedArtifacts : null,
    capabilities: {
      create: capability?.create === true && sharedArtifacts !== null,
      view: capability?.view === true && sharedArtifacts !== null,
    },
  };
}
