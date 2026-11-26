'use client';

import {
  createContext,
  useContext,
  type AnchorHTMLAttributes,
  type ComponentType,
  type CSSProperties,
  type ImgHTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
} from 'react';
import type {
  AccountOrganizationSettingsClient,
  SettingsNavigationPort,
  SettingsReplayPrivacy,
  SettingsSelectionStorage,
} from '@canopy/app-core/settings';
import type { WorkspaceContext } from '@canopy/protocol/workspace-context';

/**
 * Host ports for the hosted account and organization settings UI.
 *
 * Shared settings components never import a framework router, a host's
 * transport, its stores or its brand provider. Each host supplies one
 * {@link SettingsUiHost} through {@link SettingsHostProvider}: web over Next
 * (`next/link`, `next/image`, `next/navigation`, its brand context and the
 * browser settings client), desktop over its navigation store, preload bridge
 * and IPC settings client.
 *
 * Route-dependent ports are hooks (`useRouter`, `usePathname`, ...). A host
 * object is created once and never swaps its hook implementations, so calling
 * them from shared hooks keeps React's hook order stable. Shared components
 * call the exported wrappers below, never `host.useX()` directly.
 *
 * Shared code must not branch on which host it runs in. Capability
 * differences are explicit fields. Whether payments check out inline or hand
 * off is not one of them: it comes from the client's capabilities through
 * `CreditsPurchaseProvider` (`@canopy/ui-app/credits`).
 */

/** The anchor props shared links accept, mirroring `next/link`'s subset in use. */
export interface SettingsLinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  'href'
> {
  /** A same-origin web path (`/organization/<id>/members`) or absolute URL. */
  readonly href: string;
  readonly prefetch?: boolean | null;
  readonly replace?: boolean;
  readonly scroll?: boolean;
  readonly ref?: Ref<HTMLAnchorElement>;
  readonly children?: ReactNode;
}

export type SettingsLinkComponent = ComponentType<SettingsLinkProps>;

/** The image props shared components use, mirroring `next/image`'s subset. */
export interface SettingsImageProps {
  readonly src: string;
  readonly alt: string;
  readonly width?: number;
  readonly height?: number;
  readonly fill?: boolean;
  readonly sizes?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly unoptimized?: boolean;
  readonly priority?: boolean;
  readonly referrerPolicy?: ImgHTMLAttributes<HTMLImageElement>['referrerPolicy'];
  readonly onError?: () => void;
  readonly 'data-testid'?: string;
}

export type SettingsImageComponent = ComponentType<SettingsImageProps>;

/** Router operations over web paths, mirroring `next/navigation`'s router. */
export interface SettingsRouter {
  push(href: string, options?: { scroll?: boolean }): void;
  /** Replace the current entry, for page-owned query state and subtabs. */
  replace(href: string, options?: { scroll?: boolean }): void;
  /** Re-read the current page's first-screen data. */
  refresh(): void;
  back(): void;
}

/** The read-only search-param surface shared components use. */
export interface SettingsSearchParams {
  get(name: string): string | null;
  getAll(name: string): string[];
  has(name: string): boolean;
  toString(): string;
  forEach(callback: (value: string, key: string) => void): void;
}

/** Brand values shared settings copy may name. */
export interface SettingsBrand {
  readonly id: string;
  readonly displayName: string;
  readonly internalName: string;
}

/**
 * The viewer's workspace context. Browsing settings never changes it; only
 * explicitly choosing an organization (opening, creating or joining it) does.
 */
export interface SettingsWorkspaceContext {
  /** The workspace-context feature is on for this viewer. */
  readonly enabled: boolean;
  /** Stable key for the signed-in account, or `null` when signed out. */
  readonly accountKey: string | null;
  readonly workspaceContext: WorkspaceContext;
  /**
   * Select the organization in the main sidebar as soon as the host's
   * membership list includes it, so a just-created or just-joined
   * organization is selected once its refresh lands. Best-effort: a host
   * drops a request it cannot satisfy and never reports it as a failure.
   */
  readonly selectOrganization: (organizationId: string) => void;
}

export interface SettingsLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** What a host's stored AI gateway key row shows. */
export interface AiGatewayConnectionKeyProps {
  readonly label?: string;
  readonly onReadinessChange?: (ready: boolean) => void;
  readonly organizationId: string;
  readonly baseUrl: string;
  /** Bumped after a key is saved, so the host reads the stored key again. */
  readonly revision: number;
}

/** Sign-in found one AI gateway on the account and another on this device. */
export interface DeviceAiGatewayChoice {
  readonly deviceBaseUrl: string;
  readonly deviceDisplayName: string | null;
  readonly accountBaseUrl: string;
  readonly accountDisplayName: string | null;
  /** The account gateway revision shown; replacing it must match. */
  readonly accountRevision: string;
}

/** `device` replaces the account's gateway with this device's; `account` keeps it. */
export type DeviceAiGatewayDecision = 'device' | 'account';

/** The pending sign-in choice of a host that keeps a device AI gateway. */
export interface DeviceAiGatewayChoicePort {
  /** The pending choice, or null when there is none. */
  read(): Promise<DeviceAiGatewayChoice | null>;
  /**
   * Rejects with a `SettingsOperationError` when the choice didn't apply,
   * including a 409 `stale_revision` when the account's gateway changed
   * since `accountRevision` was read.
   */
  choose(
    decision: DeviceAiGatewayDecision,
    accountRevision: string,
  ): Promise<void>;
}

/** This computer's own key for an AI gateway, as its status row reads it. */
export type AiGatewayDeviceKeyStatus =
  | 'loading'
  | 'saved'
  | 'rejected'
  | 'missing'
  /** A key saved for another URL of the same gateway; it can't send. */
  | 'old-url'
  /** This computer doesn't use the gateway, whatever key it holds. */
  | 'not-used'
  | 'unavailable';

export interface AiGatewayDeviceKeyInput {
  readonly organizationId: string;
  readonly baseUrl: string;
  /** Bumped after a key is saved on the page, so the host reads it again. */
  readonly revision: number;
}

/** Whether this computer uses a Personal AI gateway (CAN-7644). */
export interface AiGatewayDeviceUse {
  /** `null` until this computer's choice is read. */
  readonly used: boolean | null;
  setUsed(used: boolean): Promise<void>;
}

/**
 * A file to save from an authenticated settings download route, as a
 * same-origin path (`/api/v1/settings/organization/<id>/transcripts/...`).
 * Never an absolute URL: the host supplies the origin and the credential.
 */
export interface SettingsFileDownloadRequest {
  readonly path: string;
  /** The file name to offer; hosts sanitize it again. */
  readonly suggestedName: string;
}

/**
 * What a download did. `saved: false` is a save dialog the person cancelled.
 * A host that hands the request to the browser reports `saved: true` once it
 * started; the browser reports its own failures.
 */
export type SettingsFileDownloadResult =
  | { readonly ok: true; readonly saved: boolean }
  | {
      readonly ok: false;
      readonly reason:
        | 'invalid'
        | 'unauthenticated'
        | 'forbidden'
        | 'not_found'
        | 'gone'
        | 'too_large'
        | 'busy'
        | 'failed';
    };

export type SettingsFileDownload = (
  request: SettingsFileDownloadRequest,
) => Promise<SettingsFileDownloadResult>;

export interface SettingsUiHost {
  /** Fixed-table hosted settings data access. */
  readonly client: AccountOrganizationSettingsClient;
  readonly Link: SettingsLinkComponent;
  readonly Image: SettingsImageComponent;
  /** Account-scoped persistence of the browsed organization. */
  readonly storage: SettingsSelectionStorage;
  /** Session-replay privacy class names (inert on web). */
  readonly privacy: SettingsReplayPrivacy;
  /**
   * Absolute origin of the web app, for links that leave the host (share
   * URLs, public profiles, auth callbacks). Never a desktop file origin.
   */
  webOrigin(): string;
  /** A scoped logger; hosts redact and route it. */
  logger(scope: string): SettingsLogger;
  useRouter(): SettingsRouter;
  /** The current web path equivalent (`/organization/<id>/settings`). */
  usePathname(): string;
  /** Current query parameters, including page-owned query state. */
  useSearchParams(): SettingsSearchParams;
  useNavigation(): SettingsNavigationPort;
  useBrand(): SettingsBrand;
  /** The element that scrolls the settings content, when the host has one. */
  useScrollElement(): HTMLElement | null;
  /** Effective top-up service fee percent. */
  useTopUpFeePercent(): number;
  useWorkspaceContext(): SettingsWorkspaceContext;
  /**
   * The stored key for an AI gateway on this device, such as `sk-…last4`
   * with its state. Only a host that keeps gateway keys in secure storage
   * supplies it. Without it, Connect sends a key for that request only and
   * the configured gateway asks for the key in the desktop app.
   */
  readonly AiGatewayConnectionKey?: ComponentType<AiGatewayConnectionKeyProps>;
  /**
   * The choice between the account's AI gateway and one set up on this
   * device before sign-in. Only a host that keeps a device gateway supplies it.
   */
  readonly deviceAiGatewayChoice?: DeviceAiGatewayChoicePort;
  /**
   * The state of this device's own key for an AI gateway, for the page's
   * "This computer" status. Only a host that is itself a device running
   * agents supplies it; it is the same for the host's whole lifetime.
   */
  readonly useAiGatewayDeviceKey?: (
    input: AiGatewayDeviceKeyInput,
  ) => AiGatewayDeviceKeyStatus;
  /**
   * Whether this device uses the account's Personal AI gateway, saved on the
   * device only. A device host supplies it and returns `null` while the
   * gateway isn't the account's (signed out, or another organization).
   */
  readonly useAiGatewayDeviceUse?: (
    organizationId: string,
  ) => AiGatewayDeviceUse | null;
  /**
   * Saves a file from an authenticated settings download route (organization
   * transcripts). Web follows a same-origin link; desktop asks main, which
   * shows a save dialog and fetches with the account's own credential.
   * `null` while the host can't download (desktop signed out).
   */
  readonly useDownloadFile?: () => SettingsFileDownload | null;
}

const SettingsHostContext = createContext<SettingsUiHost | null>(null);

export interface SettingsHostProviderProps {
  readonly host: SettingsUiHost;
  readonly children: ReactNode;
}

export function SettingsHostProvider({
  host,
  children,
}: SettingsHostProviderProps): JSX.Element {
  return (
    <SettingsHostContext.Provider value={host}>
      {children}
    </SettingsHostContext.Provider>
  );
}

/** The current settings host. Throws outside a {@link SettingsHostProvider}. */
export function useSettingsHost(): SettingsUiHost {
  const host = useContext(SettingsHostContext);
  if (host === null)
    throw new Error(
      'Shared settings UI must render inside a <SettingsHostProvider>.',
    );
  return host;
}

/** The current settings host, or `null` outside a provider. */
export function useOptionalSettingsHost(): SettingsUiHost | null {
  return useContext(SettingsHostContext);
}

export function useSettingsClient(): AccountOrganizationSettingsClient {
  return useSettingsHost().client;
}

export function useSettingsRouter(): SettingsRouter {
  return useSettingsHost().useRouter();
}

export function useSettingsPathname(): string {
  return useSettingsHost().usePathname();
}

export function useSettingsSearchParams(): SettingsSearchParams {
  return useSettingsHost().useSearchParams();
}

export function useSettingsNavigation(): SettingsNavigationPort {
  return useSettingsHost().useNavigation();
}

export function useSettingsBrand(): SettingsBrand {
  return useSettingsHost().useBrand();
}

export function useSettingsScrollElement(): HTMLElement | null {
  return useSettingsHost().useScrollElement();
}

export function useSettingsTopUpFeePercent(): number {
  return useSettingsHost().useTopUpFeePercent();
}

export function useSettingsWorkspaceContext(): SettingsWorkspaceContext {
  return useSettingsHost().useWorkspaceContext();
}

const NO_DOWNLOAD = (): null => null;

/** The host's file download, or `null` when it has none right now. */
export function useSettingsDownloadFile(): SettingsFileDownload | null {
  return (useSettingsHost().useDownloadFile ?? NO_DOWNLOAD)();
}

/** The host's stored-key row for AI gateways, when it keeps keys. */
export function useSettingsAiGatewayConnectionKey():
  | ComponentType<AiGatewayConnectionKeyProps>
  | undefined {
  return useSettingsHost().AiGatewayConnectionKey;
}

/** The host's device AI gateway choice, when it keeps a device gateway. */
export function useSettingsDeviceAiGatewayChoice():
  | DeviceAiGatewayChoicePort
  | undefined {
  return useSettingsHost().deviceAiGatewayChoice;
}

const NO_DEVICE_KEY = (): null => null;

/**
 * This device's key state for an AI gateway, or `null` on a host with no
 * device of its own. The host's port never changes, so the hook it names is
 * called on every render either way.
 */
export function useSettingsAiGatewayDeviceKey(
  input: AiGatewayDeviceKeyInput,
): AiGatewayDeviceKeyStatus | null {
  const useDeviceKey = useSettingsHost().useAiGatewayDeviceKey ?? NO_DEVICE_KEY;
  return useDeviceKey(input);
}

const NO_DEVICE_USE = (): null => null;

/** This device's "Use on this computer" choice, or `null` where none applies. */
export function useSettingsAiGatewayDeviceUse(
  organizationId: string,
): AiGatewayDeviceUse | null {
  const useDeviceUse = useSettingsHost().useAiGatewayDeviceUse ?? NO_DEVICE_USE;
  return useDeviceUse(organizationId);
}

export function useSettingsPrivacy(): SettingsReplayPrivacy {
  return useSettingsHost().privacy;
}

/** The host's link, for internal settings paths and guarded external URLs. */
export function SettingsLink(props: SettingsLinkProps): JSX.Element {
  const { Link } = useSettingsHost();
  return <Link {...props} />;
}

/** The host's image component (`next/image` on web, `<img>` on desktop). */
export function SettingsImage(props: SettingsImageProps): JSX.Element {
  const { Image } = useSettingsHost();
  return <Image {...props} />;
}
