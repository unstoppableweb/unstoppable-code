import { Badge } from '@canopy/ui-shared/components/Badge';
import {
  deleteDesktopMcpTarget,
  moveDesktopMcpTarget,
} from '../mcp/mcpManagementOperations';
import {
  getDefaultConfigId,
  CLOUD_DISPLAY_NAME_MAX,
  CLOUD_HTTPS_REQUIRED,
  CLOUD_SIGN_IN_REQUIRED,
  CLOUD_CONNECT_FAILED,
  CLOUD_SINGLE_CONFIG_REQUIRED,
  CLOUD_REGISTRATION_UNAVAILABLE,
  cloudMcpHeaders,
  cloudHeadersProblem,
  cloudUrlProblem,
  isCloudReadyUrl,
  defaultConfigAuthToken,
  loadSignedInAccountId,
  withoutAuthTokens,
  sameHeaders,
  clearDeviceSignIns,
  keepsStoredSecrets,
} from '../mcp/mcpManagementOperations';
import {
  isStoredSecretValue,
  type SecretValueInput,
  type StoredSecretValue,
} from '@canopy/execution-engine/types/stored-secrets';
import {
  McpMoveToCloudDialog,
  McpMoveToDeviceDialog,
} from '../mcp/McpPlacementDialogs';
import type { MarketplaceShareAction } from '@canopy/ui-shared/lib';
import { InstalledEntryStatusSection } from '../plugins/InstalledEntryStatusSection';
import { capitalizeFirstLetter } from '@canopy/ui-shared/lib';
import { flattenMcpServerRows } from '@canopy/desktop-shared/lib/mcp-server-rows';
import {
  type AccountMcpClientSetup,
  type AccountMcpOAuthClientCredentials,
} from '@canopy/protocol/mcp-servers';
import { DEFAULT_MCP_HTTP_AUTH_HANDLER } from '@canopy/desktop-shared/types';
import { useCurrentUiStateReporter } from '@/hooks/useCurrentUiStateReporter';
import { AccountMcpDetails } from '../mcp/AccountMcpControls';
import { useAccountMcpActions } from '../../hooks/useAccountMcpActions';
import {
  CUSTOM_MCP_URL_EXAMPLE,
  CustomMcpAdvanced,
  CustomMcpServerFields,
  CustomMcpServerPlacement,
  customMcpAdvancedHint,
  prefilledCustomMcpName,
  findAccountMcpRow,
  type CreatedCustomItem,
} from '@canopy/ui-app/capability';
import { extractIpcErrorMessage } from '@/lib/errors';
import { pointRefsAt } from '@/lib/mcpServerRefs';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { type JSX, useEffect, useId, useRef, useState } from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import {
  useCustomMcpCreateFlow,
  type CustomMcpCreateTarget,
} from '../../hooks/useCustomMcpCreateFlow';
import { EntityEditModalContent } from './EntityEditModalFooter';
import { BackDetailOverlayShell } from './BackDetailOverlayShell';
import {
  createEntityEditModalFooterProps,
  runCancellableModalLoad,
  runEntityEditOperation,
} from './entityEditModalUtils';
import { DialogModal } from '../shared/DialogModal';
import { ErrorBanner } from '../shared/StatusBlocks';
import { McpAccountBindingSkeleton } from './McpServersTabSkeletons';
import {
  Stack,
  DelayedLoadingPlaceholder,
  Divider,
  Surface,
  McpSignInPendingActions,
  McpSignInPendingStatus,
} from '@canopy/ui-shared/components';
import { brandText } from '@/lib/brand';
import {
  curatedMcpDesktopOnly,
  curatedMcpProviderOnly,
  type CuratedMcpRequiredConfigField,
  type CuratedMcpServerEntry,
} from '@canopy/protocol/mcp-catalog';
import type {
  AccountMcpConnectionSummary,
  SaveMcpServerRequest,
  AccountMcpConnection,
  McpHttpAuthHandler,
  McpOAuthConfigView,
  McpServerDataView,
  McpServerConfigView,
  McpServerCuratedMetadata,
  McpServerFileView,
  McpServerHealthCheckResult,
  McpServerTestConnectionResult,
  UpdateAccountMcpConnectionRequest,
} from '@canopy/execution-engine/types/mcp-servers';
import { AccountMcpConnectionError } from '@canopy/execution-engine/types/mcp-servers';
import { Button } from '@canopy/ui-shared';
import {
  Checkbox,
  ChoiceField,
  DialogFormField,
  McpClientSetupDetails,
  McpConnectionFacts,
  Notice,
  Select,
  TextInput,
  SegmentedControl,
  StandaloneConfigsSection,
  CopyDetailsButton,
} from '@canopy/ui-shared/components';
import {
  mcpDeleteImpact,
  mcpPlacementLabel,
  mcpConnectErrorMessage,
} from '@canopy/ui-shared/lib';
import {
  accountMcpUnavailableMessage,
  mcpAlreadyConnectedMessage,
  mcpNoSignInNeededMessage,
} from '../mcp/accountMcpConnectSteps';
import {
  CloseIcon as AppCatalogCloseIcon,
  ChevronRightMediumIcon as AppCatalogChevronRightMediumIcon,
  GlobeIcon as AppCatalogGlobeIcon,
  TerminalIcon as AppCatalogTerminalIcon,
} from '@canopy/ui-shared/icons/AppIcons';

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

interface OAuthFormState {
  enabled: boolean;
  advancedOpen: boolean;
  usePkce: boolean;
  clientId: string;
  callbackPort?: number;
  /**
   * The pinned port came from a curated catalog entry, so the redirect URI is
   * the vendor's to define. Never set from user input: a hand-authored port
   * keeps Canopy's own redirect shape, which is what its provider has on file.
   */
  vendorRegisteredRedirect?: boolean;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string;
  audience: string;
}

const EMPTY_OAUTH_FORM: OAuthFormState = {
  enabled: false,
  advancedOpen: false,
  usePkce: true,
  clientId: '',
  authorizationUrl: '',
  tokenUrl: '',
  scopes: '',
  audience: '',
};

export function oauthFromDefinition(
  oauth: McpOAuthConfigView | undefined,
): OAuthFormState {
  if (!oauth) return { ...EMPTY_OAUTH_FORM };
  const advancedOpen = Boolean(
    oauth.clientId ||
    oauth.callbackPort !== undefined ||
    oauth.authorizationUrl ||
    oauth.tokenUrl ||
    (oauth.scopes && oauth.scopes.length > 0) ||
    oauth.audience,
  );
  return {
    enabled: true,
    advancedOpen,
    usePkce: oauth.usePkce ?? true,
    clientId: oauth.clientId ?? '',
    callbackPort: oauth.callbackPort,
    ...(oauth.vendorRegisteredRedirect === true
      ? { vendorRegisteredRedirect: true }
      : {}),
    authorizationUrl: oauth.authorizationUrl ?? '',
    tokenUrl: oauth.tokenUrl ?? '',
    scopes: (oauth.scopes ?? []).join(' '),
    audience: oauth.audience ?? '',
  };
}

/** Build an OAuth form from a curated entry's non-secret hint subset. */
export function oauthFromCuratedHints(
  entry: CuratedMcpServerEntry,
): OAuthFormState {
  const hints = entry.oauthHints;
  const requiresClientId = Boolean(
    entry.requiredConfigFields?.some(
      (field) => field.kind === 'oauth-client-id',
    ),
  );
  if (!hints) {
    return requiresClientId
      ? { ...EMPTY_OAUTH_FORM, enabled: true, advancedOpen: true }
      : { ...EMPTY_OAUTH_FORM };
  }
  const advancedOpen = Boolean(
    hints.clientId ||
    hints.callbackPort !== undefined ||
    hints.authorizationUrl ||
    hints.tokenUrl ||
    (hints.scopes && hints.scopes.length > 0) ||
    hints.audience ||
    requiresClientId,
  );
  return {
    enabled: true,
    advancedOpen,
    usePkce: hints.usePkce ?? true,
    clientId: hints.clientId ?? '',
    callbackPort: hints.callbackPort,
    ...(hints.callbackPort !== undefined
      ? { vendorRegisteredRedirect: true }
      : {}),
    authorizationUrl: hints.authorizationUrl ?? '',
    tokenUrl: hints.tokenUrl ?? '',
    scopes: (hints.scopes ?? []).join(' '),
    audience: hints.audience ?? '',
  };
}

/** Extract the non-secret curated metadata persisted on a server definition. */
export function curatedMetadataFromEntry(
  entry: CuratedMcpServerEntry,
): McpServerCuratedMetadata {
  return {
    key: entry.key,
    ...(entry.logoUrl ? { logoUrl: entry.logoUrl } : {}),
    ...(entry.docsUrl ? { docsUrl: entry.docsUrl } : {}),
    ...(entry.supportUrl ? { supportUrl: entry.supportUrl } : {}),
    ...(entry.privacyPolicyUrl
      ? { privacyPolicyUrl: entry.privacyPolicyUrl }
      : {}),
    ...(entry.authorName ? { authorName: entry.authorName } : {}),
    ...(entry.authorUrl ? { authorUrl: entry.authorUrl } : {}),
    requiresProviderAuth: curatedRequiresProviderAuth(entry),
  };
}

/** Curated catalog metadata is valid only for HTTP server definitions. */
export function curatedMetadataForServerType(
  serverType: McpServerDataView['definition']['type'],
  curated: McpServerCuratedMetadata | undefined,
): McpServerCuratedMetadata | undefined {
  return serverType === 'http' ? curated : undefined;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

interface OAuthValidationResult {
  oauth: McpOAuthConfigView | null;
  error: string | null;
}

export function optionalNumberInputValue(
  valueAsNumber: number,
): number | undefined {
  return Number.isFinite(valueAsNumber) ? valueAsNumber : undefined;
}

export function validateOAuthForm(form: OAuthFormState): OAuthValidationResult {
  if (!form.enabled) {
    return { oauth: null, error: null };
  }
  const clientId = form.clientId.trim();
  const authorizationUrl = form.authorizationUrl.trim();
  const tokenUrl = form.tokenUrl.trim();
  if (
    form.callbackPort !== undefined &&
    (!Number.isInteger(form.callbackPort) ||
      form.callbackPort < 1 ||
      form.callbackPort > 65_535)
  ) {
    return {
      oauth: null,
      error: 'OAuth callback port must be an integer from 1 to 65535.',
    };
  }
  if (authorizationUrl && !isValidHttpUrl(authorizationUrl)) {
    return {
      oauth: null,
      error: 'OAuth Authorization URL must be http: or https:.',
    };
  }
  if (tokenUrl && !isValidHttpUrl(tokenUrl)) {
    return { oauth: null, error: 'OAuth Token URL must be http: or https:.' };
  }
  if (
    authorizationUrl &&
    tokenUrl &&
    new URL(authorizationUrl).origin !== new URL(tokenUrl).origin
  ) {
    return {
      oauth: null,
      error: 'OAuth Authorization URL and Token URL must use the same origin.',
    };
  }
  const scopes = form.scopes
    .split(/\s+/)
    .map((s: string) => s.trim())
    .filter((s: string) => s.length > 0);
  const audience = form.audience.trim();
  const oauth: McpOAuthConfigView = {
    usePkce: form.usePkce,
    ...(clientId.length > 0 ? { clientId } : {}),
    ...(form.callbackPort !== undefined
      ? { callbackPort: form.callbackPort }
      : {}),
    // Persisted so the redirect shape survives a reload. Only a curated entry
    // sets it; a port the user typed keeps Canopy's own shape.
    ...(form.vendorRegisteredRedirect === true &&
    form.callbackPort !== undefined
      ? { vendorRegisteredRedirect: true }
      : {}),
    ...(authorizationUrl.length > 0 ? { authorizationUrl } : {}),
    ...(tokenUrl.length > 0 ? { tokenUrl } : {}),
    ...(scopes.length > 0 ? { scopes } : {}),
    ...(audience.length > 0 ? { audience } : {}),
  };
  return { oauth, error: null };
}

export function curatedInitialUrl(entry: CuratedMcpServerEntry): string {
  if (!entry.urlOptions?.length) return entry.url;
  return entry.urlOptions.some((option) => option.url === entry.url)
    ? entry.url
    : entry.urlOptions[0].url;
}

export function curatedRequiresProviderAuth(
  entry: CuratedMcpServerEntry,
): boolean {
  return Boolean(
    entry.requiredConfigFields?.some(
      (field) => field.kind === 'oauth-client-secret',
    ),
  );
}

export function validateCuratedSetup(
  entry: CuratedMcpServerEntry,
  selectedUrl: string,
  form: OAuthFormState,
): string | null {
  if (
    entry.urlOptions?.length &&
    !entry.urlOptions.some((option) => option.url === selectedUrl)
  ) {
    return 'Select one of the available MCP endpoints.';
  }
  if (
    !curatedRequiresProviderAuth(entry) &&
    entry.requiredConfigFields?.some(
      (field) => field.kind === 'oauth-client-id',
    ) &&
    form.clientId.trim().length === 0
  ) {
    return 'OAuth Client ID is required for this catalog entry.';
  }
  return null;
}

function hasAnyAuthTokenConfigured(configs: McpServerConfigView[]): boolean {
  return configs.some((config) =>
    typeof config.authToken === 'string'
      ? config.authToken.trim().length > 0
      : config.authToken !== undefined,
  );
}

type McpServerScope = 'device' | 'cloud';

interface McpScopeControlProps {
  value: McpServerScope;
  cloudDisabled: boolean;
  onChange: (scope: McpServerScope) => void;
}

function McpScopeControl({
  value,
  cloudDisabled,
  onChange,
}: McpScopeControlProps): JSX.Element {
  const options: Array<{ scope: McpServerScope; label: string }> = [
    { scope: 'device', label: mcpPlacementLabel('device') },
    { scope: 'cloud', label: mcpPlacementLabel('cloud') },
  ];
  return (
    <div
      role="radiogroup"
      aria-label="Scope"
      className="inline-flex items-center gap-1 rounded-full bg-base p-1 ring-1 ring-inset ring-line-base"
      data-testid="mcp-server-scope"
    >
      {options.map(
        (option): JSX.Element => (
          <Button
            variant={value === option.scope ? 'primary' : 'ghost'}
            size="compact"
            key={option.scope}
            role="radio"
            aria-checked={value === option.scope}
            disabled={option.scope === 'cloud' && cloudDisabled}
            onClick={(): void => onChange(option.scope)}
            data-testid={`mcp-server-scope-${option.scope}`}
          >
            {option.label}
          </Button>
        ),
      )}
    </div>
  );
}

/**
 * What a Connect that opened no browser means: a saved token, or a server that
 * needs no sign-in. Only the first is connected; a failed read rejects.
 */
async function completedConnectMessage(
  serverId: string,
  configId: string | undefined,
  serverName: string,
): Promise<string> {
  const entries = await window.mcpServers.listStatus();
  const configs =
    entries.find((entry) => entry.serverId === serverId)?.configs ?? [];
  const config = configId
    ? configs.find((candidate) => candidate.configId === configId)
    : configs[0];
  if (!config) throw new Error('This MCP server is no longer available');
  if (config.authStatus === 'connected')
    return mcpAlreadyConnectedMessage(serverName);
  const inventory = await window.mcpServers.listDetected({
    selections: {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [{ serverId, configId: config.configId }],
    },
  });
  const current = inventory.servers.find(
    (server) =>
      server.serverId === serverId && server.configId === config.configId,
  );
  if (
    current?.enabled &&
    current.type === 'http' &&
    current.httpAuthHandler === 'canopy' &&
    current.authStatus === 'not_configured' &&
    !current.canConnect
  )
    return mcpNoSignInNeededMessage(serverName);
  throw new Error('Couldn’t confirm this MCP server’s sign-in. Try again.');
}

function ignoreAccountRefresh(): Promise<void> {
  return Promise.resolve();
}

// ---------------------------------------------------------------------------
// KeyValueEditor
// ---------------------------------------------------------------------------

interface KeyValueEditorProps {
  /** Saved values arrive as stored-secret values and are shown as saved. */
  entries: Record<string, SecretValueInput>;
  onChange: (entries: Record<string, SecretValueInput>) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  valueType?: string;
}

function KeyValueEditor({
  entries,
  onChange,
  keyPlaceholder = 'Key',
  valuePlaceholder = 'Value',
  valueType = 'text',
}: KeyValueEditorProps): JSX.Element {
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  function handleAdd(): void {
    if (!newKey.trim() || !newValue.trim()) return;
    onChange({ ...entries, [newKey.trim()]: newValue.trim() });
    setNewKey('');
    setNewValue('');
  }

  function handleRemove(key: string): void {
    const next = { ...entries };
    delete next[key];
    onChange(next);
  }

  return (
    <Stack gap="inline">
      {Object.entries(entries).map(([key, value]) => (
        <div key={key} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <TextInput value={key} readOnly aria-label={keyPlaceholder} />
          </div>
          <div className="min-w-0 flex-1">
            <TextInput
              type={valueType}
              value={isStoredSecretValue(value) ? '' : value}
              placeholder={isStoredSecretValue(value) ? 'Saved' : undefined}
              readOnly
              aria-label={`${key} ${valuePlaceholder}`}
            />
          </div>
          <Button
            variant="ghost-destructive"
            size="compact"
            iconOnly
            onClick={() => handleRemove(key)}
            aria-label={`Remove ${key}`}
          >
            <AppCatalogCloseIcon size="sm" />
          </Button>
        </div>
      ))}
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <TextInput
            value={newKey}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setNewKey(e.target.value)
            }
            placeholder={keyPlaceholder}
            aria-label={`New ${keyPlaceholder}`}
          />
        </div>
        <div className="min-w-0 flex-1">
          <TextInput
            type={valueType}
            value={newValue}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setNewValue(e.target.value)
            }
            placeholder={valuePlaceholder}
            aria-label={`New ${valuePlaceholder}`}
          />
        </div>
        <Button
          size="compact"
          onClick={handleAdd}
          disabled={!newKey.trim() || !newValue.trim()}
        >
          Add
        </Button>
      </div>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// ConfigEditor
// ---------------------------------------------------------------------------

interface ConfigEditorProps {
  config: McpServerConfigView;
  onChange: (config: McpServerConfigView) => void;
  onDelete: () => void;
  initialExpanded?: boolean;
}

function ConfigEditor({
  config,
  onChange,
  onDelete,
  initialExpanded = false,
}: ConfigEditorProps): JSX.Element {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [keptToken, setKeptToken] = useState<StoredSecretValue | undefined>(
    isStoredSecretValue(config.authToken) ? config.authToken : undefined,
  );
  const fieldId = useId();

  return (
    <Surface variant="group">
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2">
        <Checkbox
          checked={config.enabled}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onChange({ ...config, enabled: e.target.checked })
          }
          aria-label={`Enable ${config.name || 'config'}`}
        />
        <span className="flex-1 text-s fg-primary truncate">
          {config.name || 'Untitled config'}
        </span>
        <Button
          variant="ghost"
          size="compact"
          iconOnly
          onClick={() => setExpanded(!expanded)}
          aria-label={expanded ? 'Collapse config' : 'Expand config'}
        >
          <AppCatalogChevronRightMediumIcon
            size="sm"
            className={`transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
        </Button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <Surface variant="section" boundary="top" padding="compact" gap="item">
          {/* Name */}
          <DialogFormField label="Name" htmlFor={`${fieldId}-name`}>
            <TextInput
              id={`${fieldId}-name`}
              value={config.name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({ ...config, name: e.target.value })
              }
              placeholder="Config name"
            />
          </DialogFormField>

          {/* Description */}
          <DialogFormField
            label="Description (optional)"
            htmlFor={`${fieldId}-description`}
          >
            <TextInput
              id={`${fieldId}-description`}
              value={config.description}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({ ...config, description: e.target.value })
              }
              placeholder="Optional description"
            />
          </DialogFormField>

          {/* Env vars */}
          <div className="flex flex-col text-xs gap-1">
            <span className="block fg-secondary">Environment variables</span>
            <KeyValueEditor
              entries={config.envVars}
              onChange={(envVars: Record<string, SecretValueInput>) =>
                onChange({ ...config, envVars })
              }
              keyPlaceholder="VAR_NAME"
              valuePlaceholder="value"
            />
          </div>

          {/* Extra args */}
          <DialogFormField label="Extra arguments" htmlFor={`${fieldId}-args`}>
            <TextInput
              id={`${fieldId}-args`}
              value={config.extraArgs.join(' ')}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({
                  ...config,
                  extraArgs: e.target.value
                    .split(' ')
                    .filter((a: string) => a.length > 0),
                })
              }
              placeholder="Space-separated extra args"
            />
          </DialogFormField>

          {/* Extra headers */}
          <div className="flex flex-col text-xs gap-1">
            <span className="block fg-secondary">Extra headers</span>
            <KeyValueEditor
              entries={config.extraHeaders}
              onChange={(extraHeaders: Record<string, SecretValueInput>) =>
                onChange({ ...config, extraHeaders })
              }
              keyPlaceholder="Header-Name"
              valuePlaceholder="header-value"
            />
          </div>

          {/* Auth token */}
          <DialogFormField label="Auth token" htmlFor={`${fieldId}-token`}>
            <TextInput
              id={`${fieldId}-token`}
              type="password"
              value={
                typeof config.authToken === 'string' ? config.authToken : ''
              }
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                onChange({
                  ...config,
                  // Clearing a replacement keeps the saved token.
                  authToken: e.target.value || keptToken,
                })
              }
              placeholder={
                keptToken !== undefined
                  ? 'Saved. Type to replace'
                  : 'Bearer token'
              }
            />
          </DialogFormField>
          {isStoredSecretValue(config.authToken) && (
            <Button
              className="self-start"
              variant="ghost"
              size="compact"
              onClick={(): void => {
                setKeptToken(undefined);
                onChange({ ...config, authToken: undefined });
              }}
            >
              Remove saved token
            </Button>
          )}

          {/* Delete config */}
          <div className="pt-1">
            {!confirmDelete ? (
              <Button
                variant="ghost-destructive"
                size="compact"
                onClick={() => setConfirmDelete(true)}
              >
                Delete config
              </Button>
            ) : (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs fg-secondary">Are you sure?</span>
                <Button variant="destructive" size="compact" onClick={onDelete}>
                  Confirm
                </Button>
                <Button size="compact" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </span>
            )}
          </div>
        </Surface>
      )}
    </Surface>
  );
}

// ---------------------------------------------------------------------------
// McpServerDialog
// ---------------------------------------------------------------------------

interface McpServerDialogProps {
  serverId: string | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  /**
   * Names the server a create-mode save added, so the Customize page can open
   * its detail. Not called for edits, moves or a sign-in still in progress.
   */
  onCreated?: (server: CreatedCustomItem) => void;
  /** Skip the modal enter animation, e.g. when swapping in for another modal. */
  noEnterAnimation?: boolean;
  /**
   * Curated catalog entry used to pre-fill a create-mode dialog (name,
   * description, url, HTTP transport, OAuth hints). Curated adds attach the
   * catalog metadata and default to the Canopy proxy (`httpAuthHandler`).
   * Ignored in edit mode.
   */
  initialCurated?: CuratedMcpServerEntry;
  /** Current catalog used to rehydrate constraints for installed entries. */
  curatedEntries?: CuratedMcpServerEntry[];
  mode?: 'device' | 'account';
  entryAction?: 'move-to-device';
  onAccountConnect?: (options: {
    bearerToken?: string;
    oauthClient?: AccountMcpOAuthClientCredentials;
    endpointUrl?: string;
  }) => void;
  /**
   * A cloud connection with no copy on this device. With `serverId` null the
   * dialog edits it in place, or moves it to this device.
   */
  accountConnection?: AccountMcpConnection;
  /**
   * Account setup for a catalog server that registers no OAuth clients
   * itself: the dialog collects the user's own app, and shows the redirect
   * URI to register when the cloud sent `clientSetup`.
   */
  requiresOAuthClient?: boolean;
  clientSetup?: AccountMcpClientSetup;
  /**
   * The catalog endpoint account setup starts on, when it reopens for the one
   * `clientSetup` describes. Ignored unless it is one of the entry's options.
   */
  initialEndpointUrl?: string;
}

/** Auth Handling selector value; `''` means "use the global default". */
type AuthHandlerChoice = '' | McpHttpAuthHandler;

function isAuthHandlerChoice(value: string): value is AuthHandlerChoice {
  return (
    value === '' ||
    value === 'canopy' ||
    value === 'provider' ||
    value === 'account'
  );
}

/** Why the cloud account is never offered for a desktop-only catalog server. */
const CURATED_DESKTOP_ONLY_REASON =
  'Desktop only. This server signs in on this device.';

export function McpServerDialog({
  serverId,
  onClose,
  onSaved,
  onCreated,
  noEnterAnimation = false,
  initialCurated,
  curatedEntries = [],
  mode = 'device',
  entryAction,
  onAccountConnect,
  accountConnection,
  requiresOAuthClient = false,
  clientSetup,
  initialEndpointUrl,
}: McpServerDialogProps): JSX.Element {
  const cloudOnly = serverId === null && accountConnection !== undefined;
  const isCreate = serverId === null && !cloudOnly;
  const fieldId = useId();
  const [accountFields, setAccountFields] = useState<Record<string, string>>(
    {},
  );
  const accountConnectionsEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );

  // Form state
  const [serverType, setServerType] = useState<'command' | 'http'>('http');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<Record<string, SecretValueInput>>({});
  const [configs, setConfigs] = useState<McpServerConfigView[]>([]);
  const [oauthForm, setOauthForm] = useState<OAuthFormState>({
    ...EMPTY_OAUTH_FORM,
  });
  // HTTP-only Auth Handling preference ('' = global default).
  const [authHandler, setAuthHandler] = useState<AuthHandlerChoice>('');
  const [globalAuthHandler, setGlobalAuthHandler] =
    useState<McpHttpAuthHandler>();
  const [accountConnectionId, setAccountConnectionId] = useState('');
  const [accountConnections, setAccountConnections] = useState<
    AccountMcpConnectionSummary[]
  >([]);
  const [accountConnectionsLoading, setAccountConnectionsLoading] =
    useState(false);
  const [accountConnectionsError, setAccountConnectionsError] = useState('');
  const [accountConnectionsRetry, setAccountConnectionsRetry] = useState(0);
  // Non-secret curated metadata carried through save (create-from-catalog or
  // an already-curated server being edited).
  const [curatedMeta, setCuratedMeta] = useState<
    McpServerCuratedMetadata | undefined
  >(undefined);
  const curatedEntry =
    initialCurated ??
    curatedEntries.find((entry) => entry.key === curatedMeta?.key);
  const curatedRequiresProvider = Boolean(
    curatedMeta?.requiresProviderAuth ||
    (curatedEntry && curatedRequiresProviderAuth(curatedEntry)),
  );

  // undefined while loading; null when signed out.
  const [cloudAccountId, setCloudAccountId] = useState<string | null>();
  const accountActions = useAccountMcpActions(ignoreAccountRefresh);
  // Where the server lives when the dialog opened, and the user's choice.
  const [initialScope, setInitialScope] = useState<McpServerScope>('device');
  const [scope, setScope] = useState<McpServerScope>('device');
  const [scopeTouched, setScopeTouched] = useState(false);
  // The cloud connection an existing server lives in, when it has one.
  const [boundConnection, setBoundConnection] = useState<
    AccountMcpConnectionSummary | undefined
  >(accountConnection);
  // Write-only in the cloud; blank keeps what the cloud stores.
  const [cloudToken, setCloudToken] = useState('');
  // A device token moving to the cloud, which this window never sees.
  const [savedCloudToken, setSavedCloudToken] = useState<StoredSecretValue>();
  const [clearStoredHeaders, setClearStoredHeaders] = useState(false);
  const [confirmMoveToDevice, setConfirmMoveToDevice] = useState(false);
  const [confirmMoveToCloud, setConfirmMoveToCloud] = useState(false);
  const [moveWithoutStoredHeaders, setMoveWithoutStoredHeaders] =
    useState(false);
  // A server moved off the cloud keeps one id across retries.
  const movedDeviceId = useRef<string | null>(null);
  const pendingMoveData = useRef<
    ((deviceId: string) => SaveMcpServerRequest) | null
  >(null);
  const pendingMoveToCloud = useRef<(() => Promise<void>) | null>(null);
  const isCustomHttp = serverType === 'http' && !curatedMeta?.key;
  // A hand-entered server on this device or account; never a catalog add,
  // an edit, or account setup, which keep their own layouts.
  const customCreate = isCreate && !initialCurated && mode === 'device';
  const [nameTouched, setNameTouched] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const accountHeaders = cloudMcpHeaders(headers, configs);
  const hasAccountHeaders = Object.keys(accountHeaders).length > 0;
  const headersCloudProblem = cloudHeadersProblem(accountHeaders);
  const urlCloudProblem = cloudUrlProblem(url);
  const moveConfigProblem =
    !isCreate && initialScope === 'device' && configs.length > 1
      ? CLOUD_SINGLE_CONFIG_REQUIRED
      : undefined;
  const cloudEligible =
    isCustomHttp &&
    accountConnectionsEnabled &&
    typeof cloudAccountId === 'string' &&
    urlCloudProblem === undefined &&
    headersCloudProblem === undefined &&
    moveConfigProblem === undefined;
  const scopeAvailable = accountConnectionsEnabled && serverType === 'http';
  // New custom HTTP servers go to the cloud account until the user picks a
  // scope; ineligible input keeps them on this device as it is typed.
  const effectiveScope: McpServerScope = !scopeAvailable
    ? 'device'
    : isCreate && isCustomHttp && !scopeTouched
      ? cloudEligible
        ? 'cloud'
        : 'device'
      : scope;
  const movingToCloud =
    !isCreate && initialScope === 'device' && effectiveScope === 'cloud';
  const movingToDevice =
    initialScope === 'cloud' && effectiveScope === 'device';
  // A device server can't inherit an account default: there is no connection
  // behind it, so "Use default" resolves to the local proxy instead.
  const deviceHandler: AuthHandlerChoice = curatedRequiresProvider
    ? 'provider'
    : authHandler === 'account' ||
        (authHandler === '' && globalAuthHandler === 'account')
      ? 'canopy'
      : authHandler;
  const handlerToPersist: AuthHandlerChoice =
    effectiveScope === 'cloud' ? 'account' : deviceHandler;
  const effectiveAuthHandler = handlerToPersist || globalAuthHandler;
  const usesAccountAuth =
    accountConnectionsEnabled && effectiveAuthHandler === 'account';

  // UI state
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Track IDs of newly added configs so they start expanded
  const [expandedNewIds, setExpandedNewIds] = useState<Set<string>>(new Set());

  // Health/test state
  const [healthResult, setHealthResult] =
    useState<McpServerHealthCheckResult | null>(null);
  const [healthChecking, setHealthChecking] = useState(false);
  const [testResult, setTestResult] =
    useState<McpServerTestConnectionResult | null>(null);
  const [testRunning, setTestRunning] = useState(false);
  const [selectedConfigId, setSelectedConfigId] = useState('');
  // OAuth "Connect" state (HTTP + OAuth servers). Curated adds do NOT
  // auto-launch OAuth on save; the user connects here after saving.
  const [connecting, setConnecting] = useState(false);
  const [connectMessage, setConnectMessage] = useState('');

  // Loaded server data for edit mode
  const [loadedServer, setLoadedServer] = useState<McpServerDataView | null>(
    null,
  );

  const accessTokenRef = useRef<HTMLInputElement>(null);
  const createdReported = useRef(false);

  // Stable refs for callbacks
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onCreatedRef = useRef(onCreated);
  onCreatedRef.current = onCreated;
  const createFlow = useCustomMcpCreateFlow(
    async (target: CustomMcpCreateTarget): Promise<void> => {
      reportCreatedDeviceServer(target.saved);
      // The server works; only the list behind the dialog would be stale.
      await onSavedRef.current().catch((): void => undefined);
      onCloseRef.current();
    },
    () => onSavedRef.current(),
  );
  useEffect((): void => {
    if (customCreate && (error !== '' || createFlow.error !== ''))
      setAdvancedOpen(true);
  }, [customCreate, error, createFlow.error]);
  const savedCreateId = createFlow.savedServerId;
  // A saved device server stays one: retrying never creates a cloud copy.
  useEffect((): void => {
    if (savedCreateId === null) return;
    setScope('device');
    setScopeTouched(true);
  }, [savedCreateId]);
  const accountConnectionRef = useRef(accountConnection);
  accountConnectionRef.current = accountConnection;
  const accountConnectionKey = accountConnection?.id;

  useEffect((): (() => void) | undefined => {
    if (!accountConnectionsEnabled) return;
    let cancelled = false;
    void loadSignedInAccountId().then((id): void => {
      if (!cancelled) setCloudAccountId(id ?? null);
    });
    return (): void => {
      cancelled = true;
    };
  }, [accountConnectionsEnabled]);

  useEffect((): (() => void) => {
    let cancelled = false;
    void window.api
      .loadPreferences()
      .then((preferences): void => {
        if (!cancelled)
          setGlobalAuthHandler(
            preferences.mcpHttpAuthDefaultHandler ??
              DEFAULT_MCP_HTTP_AUTH_HANDLER,
          );
      })
      .catch((error: unknown): void => {
        if (!cancelled)
          setError(error instanceof Error ? error.message : String(error));
      });
    return (): void => {
      cancelled = true;
    };
  }, []);

  // Load server data when editing
  useEffect(() => {
    setScopeTouched(false);
    setCloudToken('');
    setClearStoredHeaders(false);
    setConfirmMoveToDevice(false);
    setConfirmMoveToCloud(false);
    pendingMoveToCloud.current = null;
    setMoveWithoutStoredHeaders(false);
    movedDeviceId.current = null;
    if (!serverId) {
      const curated = initialCurated;
      const cloud = accountConnectionRef.current;
      setInitialScope(cloud ? 'cloud' : 'device');
      setScope(cloud ? 'cloud' : 'device');
      setBoundConnection(cloud);
      setServerType('http');
      setName(curated?.name ?? cloud?.displayName ?? '');
      setDescription(curated?.shortDescription ?? '');
      setCommand('');
      setArgs('');
      const reopenedUrl = curated?.urlOptions?.find(
        (option): boolean => option.url === initialEndpointUrl,
      )?.url;
      setUrl(curated ? (reopenedUrl ?? curatedInitialUrl(curated)) : '');
      setHeaders({});
      setAccountFields({});
      const now = new Date().toISOString();
      const defaultConfigId = crypto.randomUUID();
      setConfigs([
        {
          id: defaultConfigId,
          name: 'Default',
          description: '',
          enabled: true,
          envVars: {},
          extraArgs: [],
          extraHeaders: {},
          createdAt: now,
          updatedAt: now,
        },
      ]);
      setSelectedConfigId(defaultConfigId);
      setExpandedNewIds(new Set());
      setLoadedServer(null);
      setAccountConnectionId(cloud?.id ?? '');
      setError('');
      setConfirmDelete(false);
      setHealthResult(null);
      setTestResult(null);
      setConnectMessage('');
      setOauthForm(
        curated && !curatedRequiresProvider
          ? oauthFromCuratedHints(curated)
          : { ...EMPTY_OAUTH_FORM },
      );
      // Curated adds default to the Canopy proxy; hand-entered adds inherit the
      // global default.
      setAuthHandler(
        curated ? (curatedRequiresProvider ? 'provider' : 'canopy') : '',
      );
      setCuratedMeta(curated ? curatedMetadataFromEntry(curated) : undefined);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError('');

    void runCancellableModalLoad(
      async (): Promise<void> => {
        const [result, index] = await Promise.all([
          window.mcpServers.loadServer(serverId),
          window.mcpServers.loadIndex(),
        ]);
        if (cancelled) return;
        const server = result.server;
        const entry = flattenMcpServerRows(index.servers).find(
          (candidate): boolean => candidate.id === serverId,
        );
        const handler =
          server.definition.httpAuthHandler ??
          entry?.authHandler ??
          (entry?.scope === 'account' ? 'account' : undefined);
        const inCloud =
          server.definition.type === 'http' && handler === 'account';
        // The bound connection comes from the merged list, which lists a
        // device copy under its account row.
        const bound = index.servers.find(
          (row): boolean =>
            row.accountConnection !== undefined &&
            (row.accountConnection.id === entry?.accountConnectionId ||
              row.deviceCopies?.some(
                (copy): boolean => copy.id === serverId,
              ) === true),
        )?.accountConnection;
        setLoadedServer(server);
        setAccountConnectionId(entry?.accountConnectionId ?? '');
        setBoundConnection(bound);
        setInitialScope(inCloud ? 'cloud' : 'device');
        setScope(inCloud ? 'cloud' : 'device');
        setServerType(server.definition.type);
        setName(server.definition.name);
        setDescription(server.definition.description);
        setCommand(server.definition.command ?? '');
        setArgs((server.definition.args ?? []).join(' '));
        setUrl(server.definition.url ?? '');
        setHeaders(server.definition.headers ?? {});
        setConfigs(server.configs);
        setSelectedConfigId(getDefaultConfigId(server.configs));
        setOauthForm(oauthFromDefinition(server.definition.oauth));
        setAuthHandler(handler === 'account' ? '' : (handler ?? ''));
        setCuratedMeta(server.definition.curated);
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [
    serverId,
    initialCurated,
    curatedRequiresProvider,
    accountConnectionKey,
    initialEndpointUrl,
  ]);

  useEffect(() => {
    if (configs.length === 0) {
      setSelectedConfigId('');
      return;
    }

    const selectedStillExists = configs.some(
      (config) => config.id === selectedConfigId,
    );
    if (!selectedStillExists) {
      setSelectedConfigId(getDefaultConfigId(configs));
    }
  }, [configs, selectedConfigId]);

  useEffect((): (() => void) | undefined => {
    if (
      !accountConnectionsEnabled ||
      mode === 'account' ||
      (effectiveAuthHandler !== 'account' && !curatedMeta?.key) ||
      serverType !== 'http' ||
      (!curatedMeta?.key && !accountConnectionId)
    )
      return;
    let cancelled = false;
    setAccountConnectionsLoading(true);
    setAccountConnectionsError('');
    setAccountConnections([]);
    void window.mcpServers
      .listAccountConnections()
      .then((connections): void => {
        if (!cancelled) setAccountConnections(connections);
      })
      .catch((): void => {
        if (!cancelled)
          setAccountConnectionsError(
            'Could not load account connections. Check your cloud sign-in and try again.',
          );
      })
      .finally((): void => {
        if (!cancelled) setAccountConnectionsLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [
    accountConnectionsEnabled,
    effectiveAuthHandler,
    serverType,
    accountConnectionsRetry,
    curatedMeta?.key,
    accountConnectionId,
    mode,
  ]);

  const curatedConnections = accountConnections.filter(
    (connection): boolean =>
      connection.kind === 'CURATED' &&
      connection.serverKey === curatedMeta?.key,
  );
  const matchedAccountConnection = curatedMeta?.key
    ? (curatedConnections.find(
        (connection): boolean => connection.configId === selectedConfigId,
      ) ??
      (curatedConnections.length === 1 ? curatedConnections[0] : undefined))
    : accountConnections.find(
        (connection): boolean => connection.id === accountConnectionId,
      );

  // ---- Handlers ----

  // The account list stands in when the merged index could not be read.
  const cloudConnection: AccountMcpConnectionSummary | undefined =
    boundConnection ??
    (isCustomHttp && accountConnectionId
      ? matchedAccountConnection
      : undefined);
  const cloudOwned = cloudConnection?.kind === 'CUSTOM';
  const storedHeadersNote = cloudOnly && cloudConnection?.hasExtraHeaders;
  // The cloud never returns its stored headers, so a move carries only the
  // ones on this device's copy or typed here. A connection that doesn't say
  // whether it stores any is treated as if it does.
  const storedHeadersKnown = cloudConnection?.hasExtraHeaders === true;
  const headersLeftInCloud =
    movingToDevice &&
    cloudOwned &&
    cloudConnection?.hasExtraHeaders !== false &&
    Object.keys(
      cloudMcpHeaders(
        loadedServer?.definition.headers,
        loadedServer?.configs ?? [],
      ),
    ).length === 0;
  const moveDropsStoredHeaders = headersLeftInCloud && !hasAccountHeaders;
  const urlChanged = cloudOnly
    ? url.trim().length > 0
    : url.trim() !== (loadedServer?.definition.url ?? '').trim();
  // The cloud answers a new address by asking for sign-in again unless the
  // same save brings a token.
  const cloudUrlWarning =
    effectiveScope === 'cloud' &&
    cloudOwned &&
    !movingToCloud &&
    urlChanged &&
    !cloudToken.trim();
  // A new cloud server needs a signed-in account; an existing one only
  // needs one when the save reaches the cloud, which reports it then.
  const cloudBlockedReason =
    effectiveScope === 'cloud' && isCustomHttp
      ? (urlCloudProblem ??
        headersCloudProblem ??
        moveConfigProblem ??
        (cloudAccountId === null && !cloudConnection
          ? CLOUD_SIGN_IN_REQUIRED
          : undefined))
      : undefined;

  const handleSave = async (): Promise<void> => {
    if (!name.trim() || (serverType === 'http' && !effectiveAuthHandler))
      return;
    if (initialCurated && isCreate) {
      const setupError = validateCuratedSetup(initialCurated, url, oauthForm);
      if (setupError) {
        setError(setupError);
        return;
      }
    }
    let oauthToPersist: McpOAuthConfigView | undefined;
    if (serverType === 'http' && oauthForm.enabled) {
      const validation = validateOAuthForm(oauthForm);
      if (validation.error) {
        setError(validation.error);
        setAdvancedOpen(true);
        return;
      }
      oauthToPersist = validation.oauth ?? undefined;
    }
    const curatedToPersist = curatedMetadataForServerType(
      serverType,
      curatedMeta,
    );
    const inCloud = effectiveScope === 'cloud';
    if (
      inCloud &&
      curatedToPersist?.key &&
      (accountConnectionsLoading || !matchedAccountConnection)
    ) {
      setError(
        'Connect this catalog server in your cloud account before saving.',
      );
      return;
    }
    if (
      inCloud &&
      !curatedToPersist?.key &&
      accountConnectionId &&
      !cloudOnly &&
      (accountConnectionsLoading || accountConnectionsError)
    ) {
      setError(
        accountConnectionsError || 'Account connections are still loading.',
      );
      return;
    }
    const buildServerData = (
      boundConnectionId: string | undefined,
      deviceId = loadedServer?.definition.id ??
        createFlow.savedServerIdRef.current ??
        '',
    ): SaveMcpServerRequest => {
      const now = new Date().toISOString();
      const moveConfigs =
        entryAction === 'move-to-device' && loadedServer
          ? loadedServer.configs
          : configs;
      const defaultId = getDefaultConfigId(moveConfigs);
      return {
        definition: {
          id: deviceId,
          name:
            entryAction === 'move-to-device'
              ? (loadedServer?.definition.name ??
                accountConnection?.displayName ??
                name.trim())
              : name.trim(),
          description:
            entryAction === 'move-to-device'
              ? (loadedServer?.definition.description ?? '')
              : description.trim(),
          type: serverType,
          command: serverType === 'command' ? command.trim() : undefined,
          args:
            serverType === 'command'
              ? args.split(' ').filter((a: string) => a.length > 0)
              : undefined,
          url: serverType === 'http' ? url.trim() : undefined,
          headers:
            serverType === 'http' && Object.keys(headers).length > 0
              ? headers
              : undefined,
          ...(oauthToPersist ? { oauth: oauthToPersist } : {}),
          ...(serverType === 'http' && handlerToPersist
            ? { httpAuthHandler: handlerToPersist }
            : {}),
          ...(curatedToPersist ? { curated: curatedToPersist } : {}),
          createdAt: loadedServer?.definition.createdAt ?? now,
          updatedAt: now,
        },
        // A cloud server's token lives in the cloud account, never here.
        configs:
          inCloud && !curatedToPersist?.key
            ? withoutAuthTokens(configs)
            : movingToDevice && cloudToken.trim()
              ? moveConfigs.map(
                  (config): McpServerConfigView =>
                    config.id === defaultId
                      ? { ...config, authToken: cloudToken }
                      : config,
                )
              : moveConfigs,
        ...(serverType !== 'http' || movingToDevice
          ? { accountRouting: 'clear' as const }
          : {}),
        ...(boundConnectionId
          ? { accountConnectionId: boundConnectionId }
          : {}),
      };
    };
    if (inCloud && cloudBlockedReason) {
      setError(cloudBlockedReason);
      setAdvancedOpen(true);
      return;
    }
    if (inCloud && curatedToPersist?.key) {
      await runEntityEditOperation(
        async (): Promise<void> => {
          reportCreatedDeviceServer(
            await window.mcpServers.saveServer(buildServerData(undefined)),
          );
        },
        {
          setSaving,
          setError,
          onSaved: onSavedRef.current,
          onClose: onCloseRef.current,
        },
      );
      return;
    }
    if (inCloud && cloudConnection) {
      await saveCloudEdit(cloudConnection, buildServerData);
      return;
    }
    if (inCloud) {
      const problem = !cloudAccountId
        ? CLOUD_SIGN_IN_REQUIRED
        : (headersCloudProblem ??
          (isCloudReadyUrl(url)
            ? undefined
            : (urlCloudProblem ?? CLOUD_HTTPS_REQUIRED)));
      if (problem) {
        setError(problem);
        return;
      }
      const expectedAccountId = cloudAccountId ?? undefined;
      if (movingToCloud) {
        pendingMoveToCloud.current = (): Promise<void> =>
          createAccountServer(buildServerData, expectedAccountId);
        setConfirmMoveToCloud(true);
        return;
      }
      await createAccountServer(buildServerData, expectedAccountId);
      return;
    }
    if (movingToDevice && cloudOwned && cloudConnection) {
      pendingMoveData.current = (deviceId): SaveMcpServerRequest =>
        buildServerData(undefined, deviceId);
      setMoveWithoutStoredHeaders(false);
      setConfirmMoveToDevice(true);
      return;
    }
    // Only a server this desktop signs in to can be checked before closing;
    // a command or provider-handled server closes as soon as it is saved.
    if (
      customCreate &&
      serverType === 'http' &&
      effectiveAuthHandler === 'canopy'
    ) {
      await createFlow.run(
        (savedId): SaveMcpServerRequest =>
          buildServerData(undefined, savedId ?? ''),
      );
      return;
    }
    await runEntityEditOperation(
      async (): Promise<void> => {
        reportCreatedDeviceServer(
          await window.mcpServers.saveServer(buildServerData(undefined)),
        );
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onCloseRef.current,
      },
    );
  };

  // A device save in create mode added this server; an edit reports nothing.
  const reportCreatedDeviceServer = (saved: McpServerFileView): void => {
    if (serverId !== null || cloudConnection || createdReported.current) return;
    createdReported.current = true;
    const { id, curated: savedCurated } = saved.server.definition;
    onCreatedRef.current?.({
      kind: 'mcp-server',
      serverId: id,
      ...(savedCurated?.key ? { curatedKey: savedCurated.key } : {}),
    });
  };

  // Edits the cloud connection in place and keeps the device copy, when there
  // is one, in step with it.
  const saveCloudEdit = async (
    connection: AccountMcpConnectionSummary,
    buildServerData: (boundConnectionId: string) => SaveMcpServerRequest,
  ): Promise<void> => {
    const request: UpdateAccountMcpConnectionRequest = {};
    const displayName = name.trim().slice(0, CLOUD_DISPLAY_NAME_MAX);
    if (connection.kind === 'CUSTOM') {
      // Only what changed here reaches the cloud; a device copy may carry
      // its own name.
      if (
        displayName !==
        (loadedServer?.definition.name ?? connection.displayName)
      )
        request.displayName = displayName;
      if (urlChanged && url.trim()) request.customUrl = url.trim();
      if (cloudOnly) {
        if (hasAccountHeaders) request.headers = accountHeaders;
        else if (clearStoredHeaders) request.headers = {};
      } else if (
        loadedServer &&
        // A new address drops the cloud's stored headers unless the same
        // save sends them again.
        ((urlChanged && hasAccountHeaders) ||
          !sameHeaders(
            accountHeaders,
            cloudMcpHeaders(
              loadedServer.definition.headers,
              loadedServer.configs,
            ),
          ))
      )
        request.headers = accountHeaders;
    }
    // Only a token typed here replaces the cloud's sign-in; an older device
    // copy may still hold a stale one, which the save below drops.
    if (cloudToken.trim()) request.bearerToken = cloudToken.trim();
    if (
      loadedServer &&
      keepsStoredSecrets(Object.values(request.headers ?? {}))
    ) {
      // Main sends saved headers only with the connection pinned to this
      // server's own URL in the same edit.
      request.secretSource = { serverId: loadedServer.definition.id };
      request.customUrl ??= loadedServer.definition.url;
    }
    await runEntityEditOperation(
      async (): Promise<void> => {
        if (Object.keys(request).length > 0) {
          const result = await window.mcpServers.updateAccountConnection(
            connection.id,
            {
              ...request,
              ...(cloudAccountId ? { expectedAccountId: cloudAccountId } : {}),
            },
          );
          if ('error' in result)
            throw new AccountMcpConnectionError(
              result.error.code,
              result.error.header,
            );
        }
        if (!cloudOnly)
          await window.mcpServers.saveServer(buildServerData(connection.id));
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onCloseRef.current,
      },
    );
  };

  // Moves a cloud server here: the device server is saved first, desktop
  // references follow it, and only then does the cloud connection go.
  const moveToDevice = async (): Promise<void> => {
    const connection = cloudConnection;
    const build = pendingMoveData.current;
    if (!connection || !build) return;
    if (moveDropsStoredHeaders && !moveWithoutStoredHeaders) return;
    setConfirmMoveToDevice(false);
    setSaving(true);
    setError('');
    const deviceId =
      loadedServer?.definition.id ??
      (movedDeviceId.current ??= crypto.randomUUID());
    try {
      await moveDesktopMcpTarget({
        data: build(deviceId),
        connection,
        ...(cloudAccountId ? { expectedAccountId: cloudAccountId } : {}),
      });
    } catch (err) {
      setSaving(false);
      setError(extractIpcErrorMessage(err));
      return;
    }
    try {
      await onSavedRef.current();
    } catch {
      // The server moved; only the list behind the dialog is stale.
    }
    onCloseRef.current();
  };

  // Creates the cloud connection first and binds the device row to it. A
  // browser sign-in keeps settling after the dialog closes; the table follows
  // the connection's status from there. Moving an existing device server
  // also points its references at the connection and drops its own sign-ins.
  const createAccountServer = async (
    buildServerData: (boundConnectionId: string) => SaveMcpServerRequest,
    expectedAccountId: string | undefined,
  ): Promise<void> => {
    setSaving(true);
    setError('');
    let bound = false;
    let saveError: string | undefined;
    let failure: string | undefined;
    // A move sends a token typed here, or else the device's saved one unless
    // the user chose not to move it.
    const bearerToken =
      cloudToken.trim() ||
      (movingToCloud ? savedCloudToken : defaultConfigAuthToken(configs));
    const oauthClientId =
      oauthForm.enabled && oauthForm.clientId.trim()
        ? oauthForm.clientId.trim()
        : undefined;
    const moving = movingToCloud ? loadedServer : null;
    const code = await accountActions.connect(undefined, 'default', {
      customUrl: url.trim(),
      displayName: name.trim().slice(0, CLOUD_DISPLAY_NAME_MAX),
      ...(hasAccountHeaders ? { headers: accountHeaders } : {}),
      ...(expectedAccountId ? { expectedAccountId } : {}),
      ...(moving ? { pendingKey: moving.definition.id } : {}),
      // Saved headers and tokens go by reference, resolved against this
      // device server and its own URL only.
      ...(loadedServer &&
      keepsStoredSecrets([...Object.values(accountHeaders), bearerToken])
        ? { secretSource: { serverId: loadedServer.definition.id } }
        : {}),
      onFailure: (message): void => {
        failure = message;
      },
      ...(bearerToken
        ? { bearerToken }
        : oauthClientId
          ? { oauthClient: { clientId: oauthClientId } }
          : {}),
      onStarted: async (connection): Promise<void> => {
        try {
          await window.mcpServers.saveServer(buildServerData(connection.id));
        } catch (err) {
          saveError = err instanceof Error ? err.message : String(err);
          throw err;
        }
        bound = true;
        if (serverId === null && !moving)
          onCreatedRef.current?.({
            kind: 'mcp-server',
            serverId: connection.serverKey,
            configId: connection.configId,
          });
        if (moving) {
          await clearDeviceSignIns(moving);
          // The bound device copy still routes through the cloud, so a
          // reference left behind keeps working on this device.
          await pointRefsAt(
            [
              {
                serverId: moving.definition.id,
                configId: getDefaultConfigId(configs),
              },
            ],
            { serverId: connection.serverKey, configId: connection.configId },
          ).catch((): void => undefined);
        }
        // The row now points at the connection; a failed list refresh must
        // not throw, or the connection would be rolled back under it.
        try {
          await onSavedRef.current();
        } catch {
          // The row is saved; only the list shown behind the dialog is stale.
        }
        onCloseRef.current();
      },
    });
    if (bound) return;
    setSaving(false);
    if (!saveError && code === 'oauth-client-required') {
      setError(CLOUD_REGISTRATION_UNAVAILABLE);
      accessTokenRef.current?.focus();
      return;
    }
    setError(
      saveError ??
        failure ??
        (code
          ? new AccountMcpConnectionError(code).message
          : CLOUD_CONNECT_FAILED),
    );
  };

  // The device copy goes first, so a failure there leaves the cloud server in
  // place; once it is gone, a cloud failure closes the editor with a toast.
  const handleDelete = async (): Promise<void> => {
    const connection =
      cloudOwned && initialScope === 'cloud' ? cloudConnection : undefined;
    if (!serverId && !connection) return;
    await runEntityEditOperation(
      async (): Promise<void> => {
        try {
          await deleteDesktopMcpTarget({
            ...(serverId ? { serverId } : {}),
            ...(connection ? { connection } : {}),
            ...(cloudAccountId ? { expectedAccountId: cloudAccountId } : {}),
          });
        } catch (error) {
          if (!serverId && connection)
            await onSavedRef.current().catch((): void => undefined);
          throw error;
        }
      },
      {
        setSaving,
        setError,
        onSaved: onSavedRef.current,
        onClose: onCloseRef.current,
      },
    );
  };

  const handleHealthCheck = async (): Promise<void> => {
    if (!serverId) return;
    setHealthChecking(true);
    setHealthResult(null);
    try {
      const result = await window.mcpServers.checkHealth(
        serverId,
        selectedConfigId || undefined,
      );
      setHealthResult(result);
    } catch {
      setHealthResult({
        serverId,
        configId: selectedConfigId || undefined,
        status: 'unhealthy',
        message: "Couldn't check the server. Try again.",
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setHealthChecking(false);
    }
  };

  const handleTestConnection = async (): Promise<void> => {
    if (!serverId) return;
    setTestRunning(true);
    setTestResult(null);
    try {
      const result = await window.mcpServers.testConnection(
        serverId,
        selectedConfigId || undefined,
      );
      setTestResult(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      setTestResult({
        serverId,
        configId: selectedConfigId || undefined,
        success: false,
        message: 'Connection test failed',
        error: errorMessage,
      });
    } finally {
      setTestRunning(false);
    }
  };

  const handleConnect = async (): Promise<void> => {
    if (!serverId) return;
    setConnecting(true);
    setConnectMessage('');
    try {
      const result = await window.mcpServers.startOAuthLogin({
        serverId,
        configId: selectedConfigId || undefined,
      });
      setConnectMessage(
        result.status === 'completed'
          ? await completedConnectMessage(
              serverId,
              selectedConfigId || undefined,
              name.trim() || 'This server',
            )
          : 'Switch to your browser to finish signing in, then re-check the status.',
      );
    } catch (err) {
      setConnectMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  function handleAddConfig(): void {
    const now = new Date().toISOString();
    const newId = crypto.randomUUID();
    const newConfig: McpServerConfigView = {
      id: newId,
      name: `Config ${configs.length + 1}`,
      description: '',
      enabled: true,
      envVars: {},
      extraArgs: [],
      extraHeaders: {},
      createdAt: now,
      updatedAt: now,
    };
    setConfigs([...configs, newConfig]);
    setExpandedNewIds((prev) => new Set([...Array.from(prev), newId]));
  }

  function handleUpdateConfig(
    index: number,
    updated: McpServerConfigView,
  ): void {
    setConfigs(configs.map((c, i) => (i === index ? updated : c)));
  }

  function handleDeleteConfig(index: number): void {
    setConfigs(configs.filter((_, i) => i !== index));
  }

  const willCreateAccountConnection =
    usesAccountAuth &&
    isCustomHttp &&
    !cloudConnection &&
    !(
      accountConnectionId &&
      (accountConnectionsLoading || accountConnectionsError)
    );
  const editsCloudConnection =
    effectiveScope === 'cloud' && cloudConnection !== undefined;
  const cloudOnlyInCloud = cloudOnly && effectiveScope === 'cloud';
  // Why "Cloud account" can't be chosen for a custom HTTP server.
  const cloudLocalReason =
    accountConnectionsEnabled && isCustomHttp && !cloudEligible
      ? (urlCloudProblem ??
        headersCloudProblem ??
        moveConfigProblem ??
        (cloudAccountId === null
          ? `${CLOUD_SIGN_IN_REQUIRED} It stays on this device for now.`
          : undefined))
      : undefined;
  // A catalog server joins the cloud only through its existing connection,
  // and a desktop-only one never does (REG-3035).
  const curatedDesktopOnly =
    curatedEntry !== undefined && curatedMcpDesktopOnly(curatedEntry);
  const curatedCloudReason =
    scopeAvailable && curatedMeta?.key && curatedDesktopOnly
      ? effectiveScope === 'cloud'
        ? undefined
        : CURATED_DESKTOP_ONLY_REASON
      : scopeAvailable &&
          curatedMeta?.key &&
          effectiveScope !== 'cloud' &&
          !accountConnectionsLoading &&
          !matchedAccountConnection
        ? accountConnectionsError ||
          (cloudAccountId === null
            ? `${CLOUD_SIGN_IN_REQUIRED} It stays on this device for now.`
            : 'Connect this catalog server in your cloud account first.')
        : undefined;
  const curatedCloudRetry =
    effectiveScope === 'device' &&
    cloudLocalReason === undefined &&
    curatedCloudReason !== undefined &&
    !curatedDesktopOnly;
  const cloudChoiceDisabled =
    cloudLocalReason !== undefined && effectiveScope !== 'cloud';
  const changeScope = (next: McpServerScope): void => {
    setScopeTouched(true);
    setScope(next);
    setError('');
    // A device server's token travels with it; a cloud one is write-only.
    if (next === 'cloud' && initialScope === 'device') {
      const token = defaultConfigAuthToken(configs);
      setSavedCloudToken(isStoredSecretValue(token) ? token : undefined);
      setCloudToken(typeof token === 'string' ? token : '');
    } else if (next !== initialScope) {
      setCloudToken('');
      setSavedCloudToken(undefined);
    }
  };
  const canSave =
    name.trim().length > 0 &&
    !saving &&
    !createFlow.busy &&
    (serverType !== 'http' ||
      effectiveScope === 'cloud' ||
      Boolean(deviceHandler) ||
      globalAuthHandler !== undefined) &&
    (serverType === 'command'
      ? command.trim().length > 0
      : url.trim().length > 0 || (cloudOnly && effectiveScope === 'cloud')) &&
    !(effectiveScope === 'cloud' && cloudBlockedReason);
  const entryMoveOpened = useRef(false);
  useEffect(() => {
    if (
      entryAction !== 'move-to-device' ||
      entryMoveOpened.current ||
      loading ||
      !cloudConnection ||
      !cloudAccountId ||
      globalAuthHandler === undefined
    )
      return;
    if (scope !== 'device') {
      setScope('device');
      setScopeTouched(true);
      return;
    }
    // Reuse validation and the captured move request; never save unrelated edits.
    entryMoveOpened.current = true;
    void handleSave();
  });
  const deleteNote =
    cloudOwned && initialScope === 'cloud'
      ? serverId
        ? mcpDeleteImpact('device-and-cloud')
        : mcpDeleteImpact('cloud')
      : cloudConnection && serverId
        ? mcpDeleteImpact('device-retaining-cloud')
        : undefined;
  // Leaving after a save keeps that server, so the list behind has to catch up.
  // Nothing here says it connected.
  const closeDialog = (): void => {
    createFlow.cancel();
    if (createFlow.savedServerIdRef.current !== null) {
      void onSavedRef.current().catch((): void => undefined);
    }
    onClose();
  };
  const createFailed = customCreate && createFlow.phase === 'failed';
  const footerProps = {
    ...createEntityEditModalFooterProps(
      isCreate,
      saving || createFlow.busy,
      canSave,
      confirmDelete,
      setConfirmDelete,
      () => void handleDelete(),
      closeDialog,
      () => void handleSave(),
    ),
    ...(customCreate
      ? {
          saveLabel: createFailed ? 'Try again' : 'Add server',
          savingLabel: 'Adding\u2026',
          cancelLabel: createFailed ? 'Close' : 'Cancel',
          notice: (
            <CustomMcpServerPlacement
              placement={effectiveScope === 'cloud' ? 'account' : 'desktop'}
              hasHeaders={hasAccountHeaders}
              hasToken={Boolean(
                cloudToken.trim() || defaultConfigAuthToken(configs),
              )}
            />
          ),
        }
      : {}),
  };
  const accountSetup = mode === 'account' && initialCurated !== undefined;
  useCurrentUiStateReporter(
    'mcp.serverEditor',
    accountSetup
      ? null
      : {
          mode: isCreate ? 'create' : 'edit',
          ...(serverId ? { serverId } : {}),
          cloudOnly,
          scopeAvailable,
          scope: effectiveScope,
          initialScope,
          moveToDeviceDialogOpen: confirmMoveToDevice,
          moveToCloudDialogOpen: confirmMoveToCloud,
          moveDropsStoredHeaders,
          moveWithoutStoredHeaders,
          deleteConfirmOpen: confirmDelete,
          saving,
          errorVisible: error.length > 0,
        },
  );

  if (accountSetup) {
    const declaredFields = initialCurated.requiredConfigFields ?? [];
    // A server without client registration needs the user's own app: its
    // client ID, and its secret when the server takes only confidential
    // clients and the account can store one for this server.
    const clientFields: CuratedMcpRequiredConfigField[] =
      requiresOAuthClient || clientSetup
        ? [
            { kind: 'oauth-client-id' },
            ...(clientSetup?.clientSecretAccepted &&
            clientSetup.clientSecretRequired
              ? [{ kind: 'oauth-client-secret' as const }]
              : []),
          ]
        : [];
    const setupFields = [
      ...declaredFields,
      ...clientFields.filter(
        (field): boolean =>
          !declaredFields.some(
            (declared): boolean => declared.kind === field.kind,
          ),
      ),
    ];
    // A client secret always needs an accompanying client ID, even when the
    // catalog only marks the secret as a required input.
    const requiredFields =
      setupFields.some(
        (field): boolean => field.kind === 'oauth-client-secret',
      ) &&
      !setupFields.some((field): boolean => field.kind === 'oauth-client-id')
        ? [{ kind: 'oauth-client-id' as const }, ...setupFields]
        : setupFields;
    // An optional secret the account can store rides along when typed.
    const optionalSecret =
      clientSetup?.clientSecretAccepted === true &&
      !requiredFields.some(
        (field): boolean => field.kind === 'oauth-client-secret',
      );
    const supportedFields = requiredFields.every(
      (field): boolean =>
        field.kind === 'oauth-client-id' ||
        field.kind === 'oauth-client-secret',
    );
    const collectsOauthClient = requiredFields.some(
      (field): boolean => field.kind === 'oauth-client-id',
    );
    const formFields = optionalSecret
      ? [...requiredFields, { kind: 'oauth-client-secret' as const }]
      : requiredFields;
    const unsupportedMessage =
      'This server needs setup fields that account connections do not support yet.';
    const connectAccount = (): void => {
      if (!supportedFields) return;
      if (
        requiredFields.some(
          (field): boolean => !accountFields[field.kind]?.trim(),
        )
      ) {
        setError('Fill in each required field to connect.');
        return;
      }
      if (
        initialCurated.urlOptions?.length &&
        !initialCurated.urlOptions.some((option): boolean => option.url === url)
      ) {
        setError('Select one of the available MCP endpoints.');
        return;
      }
      onAccountConnect?.({
        ...(collectsOauthClient && accountFields['oauth-client-id']?.trim()
          ? {
              oauthClient: {
                clientId: accountFields['oauth-client-id'].trim(),
                ...(accountFields['oauth-client-secret']
                  ? { clientSecret: accountFields['oauth-client-secret'] }
                  : {}),
              },
            }
          : {}),
        ...(initialCurated.urlOptions?.length ? { endpointUrl: url } : {}),
      });
    };
    return (
      <DialogModal
        onClose={onClose}
        title={`Connect ${initialCurated.name}`}
        titleId="mcp-server-dialog-title"
        maxWidth="xl"
        closeOnBackdrop
      >
        <Stack gap="group" data-testid="mcp-account-setup">
          {requiresOAuthClient && !clientSetup && (
            <p className="text-s fg-secondary">
              {mcpConnectErrorMessage('client_credentials_required')}
            </p>
          )}
          {clientSetup && (
            <McpClientSetupDetails
              serverName={initialCurated.name}
              redirectUri={clientSetup.redirectUri}
              {...(clientSetup.docsUrl ? { docsUrl: clientSetup.docsUrl } : {})}
              clientSecretRequired={clientSetup.clientSecretRequired}
              clientSecretAccepted={clientSetup.clientSecretAccepted}
              registrationRefused={clientSetup.registrationRefused === true}
            />
          )}
          {initialCurated.urlOptions?.length ? (
            <DialogFormField label="Endpoint" htmlFor={`${fieldId}-endpoint`}>
              <Select
                id={`${fieldId}-endpoint`}
                options={initialCurated.urlOptions.map((option) => ({
                  value: option.url,
                  label: option.label,
                }))}
                value={url}
                onValueChange={setUrl}
                data-testid="mcp-curated-url-option"
              />
            </DialogFormField>
          ) : null}
          {supportedFields ? (
            formFields.map(
              (field): JSX.Element => (
                <DialogFormField
                  key={field.kind}
                  label={
                    field.kind === 'oauth-client-id'
                      ? 'OAuth client ID'
                      : optionalSecret
                        ? 'OAuth client secret (optional)'
                        : 'OAuth client secret'
                  }
                  htmlFor={`${fieldId}-${field.kind}`}
                >
                  <TextInput
                    id={`${fieldId}-${field.kind}`}
                    type={
                      field.kind === 'oauth-client-secret' ? 'password' : 'text'
                    }
                    autoComplete="off"
                    value={accountFields[field.kind] ?? ''}
                    onChange={(event): void =>
                      setAccountFields({
                        ...accountFields,
                        [field.kind]: event.target.value,
                      })
                    }
                    data-testid={`mcp-account-${field.kind}`}
                  />
                </DialogFormField>
              ),
            )
          ) : (
            <p className="text-s fg-secondary">{unsupportedMessage}</p>
          )}
          <Stack gap="page">
            <ErrorBanner className="" error={error} />
            <div className="flex justify-end gap-2">
              <Button size="compact" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="compact"
                variant="primary"
                onClick={connectAccount}
                disabled={!supportedFields}
              >
                Connect
              </Button>
            </div>
          </Stack>
        </Stack>
      </DialogModal>
    );
  }

  const serverTypeField = !cloudOnly && (
    <div className="flex flex-col gap-1.5 text-s">
      <span className="block fg-secondary">Server type</span>
      <SegmentedControl<'command' | 'http'>
        label="Server type"
        value={serverType}
        width="content"
        shape="capsule"
        options={[
          {
            value: 'command',
            label: 'Command',
            leading: <AppCatalogTerminalIcon size="sm" />,
          },
          {
            value: 'http',
            label: 'HTTP',
            leading: <AppCatalogGlobeIcon size="sm" />,
          },
        ]}
        onChange={setServerType}
      />
    </div>
  );
  const descriptionField = !cloudOnlyInCloud && (
    <DialogFormField
      label="Description (optional)"
      htmlFor={`${fieldId}-description`}
    >
      <TextInput
        id={`${fieldId}-description`}
        value={description}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
          setDescription(e.target.value)
        }
        placeholder="Optional description"
      />
    </DialogFormField>
  );
  const commandScopeField = serverType === 'command' &&
    accountConnectionsEnabled && (
      <div className="flex flex-col gap-1.5 text-s">
        <span className="fg-secondary">Scope</span>
        <McpScopeControl value="device" cloudDisabled onChange={changeScope} />
        <p
          className="text-xs fg-secondary"
          data-testid="mcp-cloud-local-reason"
        >
          Desktop only. Command servers run on this device.
        </p>
      </div>
    );
  const httpAdvancedFields = (
    <>
      {scopeAvailable && (
        <div className="flex flex-col gap-1.5 text-s">
          <span className="fg-secondary">Scope</span>
          <McpScopeControl
            value={effectiveScope}
            cloudDisabled={
              cloudChoiceDisabled ||
              curatedCloudReason !== undefined ||
              savedCreateId !== null
            }
            onChange={changeScope}
          />
          <span className="text-xs fg-secondary">
            {effectiveScope === 'cloud'
              ? 'Stored in your cloud account. Cloud chats and every signed-in desktop can use it.'
              : 'Runs on this device. Its credentials stay here.'}
          </span>
        </div>
      )}

      {effectiveScope === 'device' && (
        <DialogFormField
          label="Auth handling"
          htmlFor={`${fieldId}-auth-handler`}
          description={
            deviceHandler === 'provider'
              ? 'The agent provider receives this server directly and handles auth.'
              : deviceHandler === 'canopy'
                ? `${brandText.appName} routes this server through its local proxy and owns auth.`
                : `Inherit the global default for how this server's auth is handled.`
          }
        >
          <Select
            id={`${fieldId}-auth-handler`}
            options={[
              ...(globalAuthHandler !== 'account'
                ? [
                    {
                      value: '',
                      label: 'Use default',
                      disabled: curatedRequiresProvider,
                    },
                  ]
                : []),
              {
                value: 'canopy',
                label: `${brandText.appName} proxy`,
                disabled: curatedRequiresProvider,
              },
              { value: 'provider', label: 'Agent provider' },
            ]}
            value={deviceHandler}
            onValueChange={(value): void => {
              if (isAuthHandlerChoice(value)) setAuthHandler(value);
            }}
            data-testid="mcp-server-auth-handler"
            disabled={curatedRequiresProvider}
          />
        </DialogFormField>
      )}

      {effectiveScope === 'cloud' && curatedMeta?.key && (
        <div className="text-s" data-testid="mcp-account-binding">
          {accountConnectionsLoading ? (
            <DelayedLoadingPlaceholder slowNote="Still loading account connections…">
              <McpAccountBindingSkeleton />
            </DelayedLoadingPlaceholder>
          ) : accountConnectionsError ? (
            <ErrorBanner error={accountConnectionsError} />
          ) : (
            <p className="fg-secondary" data-testid="mcp-account-match">
              {matchedAccountConnection
                ? `Account connection: ${matchedAccountConnection.displayName}`
                : 'Connect this catalog server in your cloud account before saving.'}
            </p>
          )}
          {!accountConnectionsLoading && !matchedAccountConnection && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(): void =>
                setAccountConnectionsRetry((retry): number => retry + 1)
              }
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {effectiveScope === 'cloud' && isCustomHttp && (
        <div
          className="flex flex-col gap-3 text-s"
          data-testid="mcp-cloud-placement"
        >
          {!customCreate && (willCreateAccountConnection || movingToCloud) && (
            <div className="flex flex-col gap-1">
              <p className="fg-primary">
                {movingToCloud
                  ? 'Will move to your cloud account'
                  : 'Will be added to your cloud account'}
              </p>
              {movingToCloud && (
                <p
                  className="text-xs fg-secondary"
                  data-testid="mcp-cloud-move-carries"
                >
                  Its URL, headers, and access token move to your cloud account.
                  OAuth sign-ins don't move, so sign in again after you save if
                  it uses OAuth.
                </p>
              )}
            </div>
          )}
          {hasAccountHeaders && (
            <p
              className="text-xs fg-secondary"
              data-testid="mcp-cloud-headers-consent"
            >
              Its headers are stored in your cloud account too.
            </p>
          )}
          <DialogFormField
            label="Access token"
            htmlFor={`${fieldId}-cloud-token`}
            description={
              !editsCloudConnection
                ? 'Optional. The token is stored in your cloud account.'
                : cloudConnection?.authMode === 'BEARER'
                  ? 'Leave it empty to keep the stored token.'
                  : 'Optional. Connects with this token instead of signing in.'
            }
          >
            <TextInput
              id={`${fieldId}-cloud-token`}
              ref={accessTokenRef}
              type="password"
              autoComplete="off"
              value={cloudToken}
              onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                setCloudToken(e.target.value)
              }
              placeholder={
                savedCloudToken !== undefined
                  ? 'Saved. Type to replace'
                  : editsCloudConnection &&
                      cloudConnection?.authMode === 'BEARER'
                    ? 'Stored'
                    : 'Optional'
              }
              data-testid="mcp-cloud-access-token"
            />
          </DialogFormField>
          {savedCloudToken !== undefined && !cloudToken && (
            <Button
              variant="ghost"
              size="compact"
              className="self-start"
              onClick={(): void => setSavedCloudToken(undefined)}
              data-testid="mcp-cloud-drop-saved-token"
            >
              Don't move token
            </Button>
          )}
          {cloudUrlWarning && (
            <Notice
              role="none"
              intent="attention"
              data-testid="mcp-cloud-url-warning"
            >
              Changing the URL signs you out. Sign in again after you save.
            </Notice>
          )}
        </div>
      )}

      {movingToDevice && cloudOwned && (
        <div
          className="flex flex-col gap-3 text-s"
          data-testid="mcp-device-placement"
        >
          <p className="fg-primary">Will move to this device</p>
          <DialogFormField
            label="Access token"
            htmlFor={`${fieldId}-device-token`}
            description="Optional. Stored on this device. Or turn on OAuth below and connect after you save."
          >
            <TextInput
              id={`${fieldId}-device-token`}
              type="password"
              autoComplete="off"
              value={cloudToken}
              onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                setCloudToken(e.target.value)
              }
              placeholder="Optional"
              data-testid="mcp-device-access-token"
            />
          </DialogFormField>
        </div>
      )}

      {(effectiveScope === 'device'
        ? (cloudLocalReason ?? curatedCloudReason)
        : cloudBlockedReason) && (
        <div className="flex items-center justify-between gap-2">
          <p
            className="text-xs fg-secondary"
            data-testid="mcp-cloud-local-reason"
          >
            {effectiveScope === 'device'
              ? (cloudLocalReason ?? curatedCloudReason)
              : cloudBlockedReason}
          </p>
          {curatedCloudRetry && (
            <Button
              variant="ghost"
              size="sm"
              onClick={(): void =>
                setAccountConnectionsRetry((retry): number => retry + 1)
              }
            >
              Try again
            </Button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-1.5 text-s">
        <span className="block fg-secondary">Headers</span>
        <Stack gap="inline">
          {storedHeadersNote && effectiveScope === 'cloud' && (
            <div
              className="flex items-center justify-between gap-2 text-xs fg-secondary"
              data-testid="mcp-cloud-stored-headers"
            >
              <span>
                {clearStoredHeaders
                  ? 'Stored headers are removed when you save.'
                  : 'Custom headers are stored in your cloud account. Add headers here to replace them.'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={(): void =>
                  setClearStoredHeaders((current): boolean => !current)
                }
              >
                {clearStoredHeaders
                  ? 'Keep stored headers'
                  : 'Remove stored headers'}
              </Button>
            </div>
          )}
          {headersLeftInCloud && (
            <Notice
              role="none"
              intent="attention"
              data-testid="mcp-cloud-stored-headers"
            >
              {storedHeadersKnown
                ? "Its stored headers can't be copied to this device. Enter them again here to keep them."
                : "It may have stored headers, which can't be copied to this device. Enter them again here to keep them."}
            </Notice>
          )}
          <KeyValueEditor
            entries={headers}
            onChange={setHeaders}
            keyPlaceholder="Header-Name"
            valuePlaceholder="header-value"
          />
        </Stack>
      </div>

      {curatedRequiresProvider && (
        <Surface variant="group" data-testid="mcp-curated-provider-auth">
          <div className="px-3 py-2 text-s fg-secondary">
            This catalog entry requires a confidential OAuth client. The agent
            provider will handle authentication so the client secret is never
            stored in the local server definition.
          </div>
        </Surface>
      )}

      {/* OAuth section (HTTP only, for locally managed public clients) */}
      {!curatedRequiresProvider && !cloudOnlyInCloud && (
        <Surface variant="group" padding="compact">
          <div className="flex flex-col gap-3">
            <ChoiceField
              checked={oauthForm.enabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>): void =>
                setOauthForm({
                  ...oauthForm,
                  enabled: e.target.checked,
                })
              }
              label={<span className="font-medium">Use OAuth</span>}
              description={`${brandText.appName} discovers OAuth settings from the HTTP MCP server, uses a local loopback callback, and stores tokens in secure local storage.`}
              data-testid="mcp-server-use-oauth"
            />

            {oauthForm.enabled && (
              <div>
                <Divider />
                <div className="flex flex-col gap-3 pt-3">
                  {oauthForm.enabled && hasAnyAuthTokenConfigured(configs) && (
                    <Notice
                      role="none"
                      intent="attention"
                      title="OAuth covers proxied sessions"
                      data-testid="mcp-server-oauth-token-warning"
                    >
                      The static token is kept only for non-OAuth use.
                    </Notice>
                  )}

                  <Surface variant="group" size="small">
                    <div className="px-3 py-2 text-xs fg-secondary">
                      PKCE and the loopback redirect are managed by{' '}
                      {brandText.appName}.
                    </div>
                  </Surface>

                  <Button
                    size="compact"
                    onClick={(): void =>
                      setOauthForm({
                        ...oauthForm,
                        advancedOpen: !oauthForm.advancedOpen,
                      })
                    }
                    className="self-start"
                  >
                    {oauthForm.advancedOpen
                      ? 'Hide advanced OAuth overrides'
                      : 'Show advanced OAuth overrides'}
                  </Button>

                  {oauthForm.advancedOpen && (
                    <Surface variant="group" size="small">
                      <div className="flex flex-col gap-3 p-3">
                        <p className="text-xs fg-secondary">
                          Fill these only when OAuth discovery or dynamic
                          registration is unavailable for this MCP server.
                        </p>

                        <DialogFormField
                          label={
                            curatedEntry?.requiredConfigFields?.some(
                              (field) => field.kind === 'oauth-client-id',
                            )
                              ? 'Client ID'
                              : 'Client ID (optional)'
                          }
                          htmlFor={`${fieldId}-oauth-client-id`}
                        >
                          <TextInput
                            id={`${fieldId}-oauth-client-id`}
                            value={oauthForm.clientId}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ): void =>
                              setOauthForm({
                                ...oauthForm,
                                clientId: e.target.value,
                              })
                            }
                            placeholder="optional client id"
                          />
                        </DialogFormField>

                        <div className="flex flex-col gap-1 text-xs">
                          <p className="fg-secondary">
                            Standalone saved client secrets are not supported.
                          </p>
                          <p className="text-2xs fg-secondary">
                            {brandText.appName} stores standalone MCP server
                            definitions on disk, so this editor only supports
                            public-client OAuth metadata plus PKCE.
                          </p>
                        </div>

                        <DialogFormField
                          label="Callback port (optional)"
                          htmlFor={`${fieldId}-oauth-callback-port`}
                          description={
                            <>
                              Uses a dedicated loopback listener instead of the
                              shared MCP proxy port. Register{' '}
                              {/* The shape depends on who owns the OAuth
                                  client. A catalog entry pins a port because
                                  the vendor registered the redirect; anything
                                  typed here is the user's own client, and
                                  Canopy keeps its own shape for it. Stating
                                  one unconditionally sent half the users to
                                  register a URI Canopy would never send. */}
                              <code>
                                {oauthForm.vendorRegisteredRedirect === true
                                  ? 'http://localhost:<port>/callback'
                                  : 'http://127.0.0.1:<port>/oauth/callback'}
                              </code>{' '}
                              with the OAuth provider.
                            </>
                          }
                        >
                          <TextInput
                            id={`${fieldId}-oauth-callback-port`}
                            type="number"
                            min={1}
                            max={65_535}
                            step={1}
                            inputMode="numeric"
                            value={oauthForm.callbackPort ?? ''}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ): void => {
                              setOauthForm({
                                ...oauthForm,
                                callbackPort: optionalNumberInputValue(
                                  e.currentTarget.valueAsNumber,
                                ),
                              });
                            }}
                            placeholder="e.g. 3118"
                            data-testid="mcp-server-oauth-callback-port"
                          />
                        </DialogFormField>

                        <DialogFormField
                          label="Authorization URL (optional)"
                          htmlFor={`${fieldId}-oauth-authorizationUrl`}
                        >
                          <TextInput
                            id={`${fieldId}-oauth-authorizationUrl`}
                            value={oauthForm.authorizationUrl}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ): void =>
                              setOauthForm({
                                ...oauthForm,
                                authorizationUrl: e.target.value,
                              })
                            }
                            placeholder="optional authorization endpoint"
                          />
                        </DialogFormField>

                        <DialogFormField
                          label="Token URL (optional)"
                          htmlFor={`${fieldId}-oauth-tokenUrl`}
                        >
                          <TextInput
                            id={`${fieldId}-oauth-tokenUrl`}
                            value={oauthForm.tokenUrl}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ): void =>
                              setOauthForm({
                                ...oauthForm,
                                tokenUrl: e.target.value,
                              })
                            }
                            placeholder="optional token endpoint"
                          />
                        </DialogFormField>

                        <DialogFormField
                          label="Scopes (optional)"
                          htmlFor={`${fieldId}-oauth-scopes`}
                        >
                          <TextInput
                            id={`${fieldId}-oauth-scopes`}
                            value={oauthForm.scopes}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ): void =>
                              setOauthForm({
                                ...oauthForm,
                                scopes: e.target.value,
                              })
                            }
                            placeholder="optional scopes"
                          />
                        </DialogFormField>

                        <DialogFormField
                          label="Audience (optional)"
                          htmlFor={`${fieldId}-oauth-audience`}
                        >
                          <TextInput
                            id={`${fieldId}-oauth-audience`}
                            value={oauthForm.audience}
                            onChange={(
                              e: React.ChangeEvent<HTMLInputElement>,
                            ): void =>
                              setOauthForm({
                                ...oauthForm,
                                audience: e.target.value,
                              })
                            }
                            placeholder="optional audience"
                          />
                        </DialogFormField>
                      </div>
                    </Surface>
                  )}
                </div>
              </div>
            )}
          </div>
        </Surface>
      )}
    </>
  );
  const configurationsField = !cloudOnlyInCloud && (
    <div>
      <Divider />
      <div className="flex flex-col gap-3 pt-4">
        <div className="flex items-center justify-between">
          <span className="text-s font-medium fg-primary">Configurations</span>
          <Button
            size="compact"
            onClick={handleAddConfig}
            data-testid="mcp-server-add-config"
          >
            Add
          </Button>
        </div>

        <div>
          {configs.length === 0 && (
            <p className="text-xs fg-secondary py-3 text-center">
              No configurations. Add one to define environment-specific
              settings.
            </p>
          )}

          <div className="flex flex-col gap-2">
            {configs.map((config, index) => (
              <ConfigEditor
                key={config.id || `new-${index}`}
                config={config}
                initialExpanded={expandedNewIds.has(config.id)}
                onChange={(updated: McpServerConfigView) =>
                  handleUpdateConfig(index, updated)
                }
                onDelete={() => handleDeleteConfig(index)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
  const commandFields = serverType === 'command' && (
    <>
      <DialogFormField label="Command" htmlFor={`${fieldId}-command`}>
        <TextInput
          id={`${fieldId}-command`}
          value={command}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setCommand(e.target.value)
          }
          placeholder="npx"
        />
      </DialogFormField>
      <DialogFormField
        label="Arguments"
        htmlFor={`${fieldId}-args`}
        description="Space-separated arguments"
      >
        <TextInput
          id={`${fieldId}-args`}
          value={args}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setArgs(e.target.value)
          }
          placeholder="-y @modelcontextprotocol/server-postgres"
        />
      </DialogFormField>
    </>
  );

  return (
    <>
      <DialogModal
        inset="flush"
        onClose={closeDialog}
        title={
          customCreate
            ? 'Add custom MCP server'
            : isCreate
              ? 'New MCP server'
              : 'Edit MCP server'
        }
        titleId="mcp-server-dialog-title"
        maxWidth="3xl"
        headerBorder={false}
        closeOnBackdrop
        noEnterAnimation={noEnterAnimation}
      >
        <EntityEditModalContent
          loading={loading}
          error={error}
          bodyClassName="flex flex-1 min-h-0 flex-col gap-4 px-6 pb-6 overflow-y-auto"
          footerProps={footerProps}
        >
          {isCreate &&
            initialCurated &&
            curatedMcpProviderOnly(initialCurated) && (
              // A provider connector never signs in from this editor; say
              // where it does here, where the modal keeps the user's focus.
              // A server the catalog marks desktop only does sign in here.
              <Notice
                intent="neutral"
                role="status"
                data-testid="mcp-server-provider-connector-notice"
              >
                {accountMcpUnavailableMessage(initialCurated)}
              </Notice>
            )}
          {confirmDelete && deleteNote && (
            <Notice
              role="none"
              intent="attention"
              data-testid="mcp-server-delete-scope"
            >
              {deleteNote}
            </Notice>
          )}

          {/* Health / Test buttons for existing servers */}
          {serverId && (
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-55">
                <DialogFormField
                  label="Config to validate"
                  htmlFor={`${fieldId}-validate-config`}
                >
                  <Select
                    id={`${fieldId}-validate-config`}
                    options={
                      configs.length === 0
                        ? [{ value: '', label: 'No configs available' }]
                        : configs.map((config) => ({
                            value: config.id,
                            label: `${config.name}${config.enabled ? '' : ' (disabled)'}`,
                          }))
                    }
                    value={selectedConfigId}
                    onValueChange={setSelectedConfigId}
                    disabled={configs.length === 0}
                  />
                </DialogFormField>
              </div>
              <Button
                size="compact"
                onClick={() => void handleHealthCheck()}
                disabled={healthChecking || configs.length === 0}
              >
                {healthChecking ? 'Checking\u2026' : 'Health check'}
              </Button>
              <Button
                size="compact"
                onClick={() => void handleTestConnection()}
                disabled={testRunning || configs.length === 0}
              >
                {testRunning ? 'Testing\u2026' : 'Test connection'}
              </Button>
              {serverType === 'http' &&
                effectiveAuthHandler !== 'account' &&
                oauthForm.enabled && (
                  <Button
                    variant="primary"
                    size="compact"
                    onClick={() => void handleConnect()}
                    disabled={connecting || configs.length === 0}
                    data-testid="mcp-server-connect"
                  >
                    {connecting ? 'Connecting\u2026' : 'Connect'}
                  </Button>
                )}
            </div>
          )}

          {/* Connect (OAuth) result */}
          {connectMessage && (
            <Surface variant="group">
              <div className="px-3 py-2 text-xs fg-secondary">
                {connectMessage}
              </div>
            </Surface>
          )}

          {/* Health check result */}
          {healthResult && (
            <Notice
              intent={
                healthResult.status === 'healthy'
                  ? 'positive'
                  : healthResult.status === 'needs_auth'
                    ? 'attention'
                    : 'destructive'
              }
              title={capitalizeFirstLetter(
                healthResult.status.replace(/_/g, ' '),
              )}
              detail={
                healthResult.responseTime != null
                  ? `Response time: ${healthResult.responseTime}ms`
                  : undefined
              }
            >
              {healthResult.message}
            </Notice>
          )}

          {/* Test connection result */}
          {testResult && (
            <Stack gap="inline">
              <Notice
                intent={testResult.success ? 'positive' : 'destructive'}
                title={testResult.success ? 'Connected' : "Couldn't connect"}
                actions={
                  !testResult.success && testResult.error ? (
                    <CopyDetailsButton details={testResult.error} />
                  ) : undefined
                }
                detail={
                  testResult.responseTime != null
                    ? `Response time: ${testResult.responseTime}ms`
                    : undefined
                }
              >
                {testResult.message}
              </Notice>
              {testResult.tools && testResult.tools.length > 0 && (
                <div className="flex flex-col text-xs gap-1">
                  <p className="fg-secondary">
                    Available tools ({testResult.tools.length}):
                  </p>
                  <div className="flex flex-wrap gap-1">
                    {testResult.tools.map((tool: string) => (
                      <Badge key={tool}>{tool}</Badge>
                    ))}
                  </div>
                </div>
              )}
            </Stack>
          )}

          {!customCreate && serverTypeField}

          {/* Name, the host's own fields, and the URL */}
          <CustomMcpServerFields
            name={{
              id: `${fieldId}-name`,
              label: 'Name',
              value: name,
              onChange: (value: string): void => {
                setName(value);
                setNameTouched(true);
              },
              inputProps: {
                placeholder: 'My MCP server',
                maxLength: CLOUD_DISPLAY_NAME_MAX,
                autoFocus: true,
              },
            }}
            between={
              <>
                {!customCreate && descriptionField}
                {commandFields}
                {!customCreate && commandScopeField}
              </>
            }
            url={
              serverType === 'http' &&
              !(initialCurated?.urlOptions?.length && isCreate)
                ? {
                    id: `${fieldId}-url`,
                    label: customCreate
                      ? 'Server URL'
                      : cloudOnly && effectiveScope === 'cloud'
                        ? 'URL (optional)'
                        : 'URL',
                    value: url,
                    onChange: setUrl,
                    testId: 'mcp-server-url',
                    hint: cloudOnly ? (
                      <span data-testid="mcp-server-url-hint">
                        {effectiveScope === 'device'
                          ? 'Enter the full URL to run it on this device.'
                          : cloudConnection?.upstreamHost
                            ? `Leave it empty to keep ${cloudConnection.upstreamHost}.`
                            : 'Leave it empty to keep the current address.'}
                      </span>
                    ) : undefined,
                    inputProps: {
                      ...(customCreate
                        ? {
                            onBlur: (): void => {
                              if (!customCreate) return;
                              const prefilled = prefilledCustomMcpName(
                                name,
                                nameTouched,
                                url,
                                CLOUD_DISPLAY_NAME_MAX,
                              );
                              if (prefilled !== null) setName(prefilled);
                            },
                          }
                        : {}),
                      placeholder: customCreate
                        ? CUSTOM_MCP_URL_EXAMPLE
                        : cloudOnly && cloudConnection?.upstreamHost
                          ? `https://${cloudConnection.upstreamHost}/…`
                          : 'https://mcp.example.com/sse',
                    },
                  }
                : undefined
            }
          />

          {/* HTTP fields */}
          {serverType === 'http' && (
            <>
              {initialCurated?.urlOptions?.length && isCreate ? (
                <DialogFormField
                  label="Endpoint"
                  htmlFor={`${fieldId}-endpoint`}
                >
                  <Select
                    id={`${fieldId}-endpoint`}
                    options={initialCurated.urlOptions.map((option) => ({
                      value: option.url,
                      label: option.description
                        ? `${option.label} — ${option.description}`
                        : option.label,
                    }))}
                    value={url}
                    onValueChange={setUrl}
                    data-testid="mcp-curated-url-option"
                  />
                </DialogFormField>
              ) : null}

              {!customCreate && httpAdvancedFields}
            </>
          )}

          {customCreate && (
            <>
              {(createFlow.phase === 'saving' ||
                createFlow.phase === 'testing') && (
                <p
                  role="status"
                  className="text-xs fg-secondary"
                  data-testid="mcp-server-create-checking"
                >
                  {createFlow.phase === 'saving'
                    ? 'Adding the server\u2026'
                    : 'Checking the connection\u2026'}
                </p>
              )}
              {createFlow.phase === 'signing-in' && (
                <div
                  className="flex flex-wrap items-center justify-between gap-2"
                  data-testid="mcp-server-create-sign-in"
                >
                  <McpSignInPendingStatus serviceName={name.trim()} />
                  {createFlow.authorizationUrl !== null && (
                    <McpSignInPendingActions
                      serviceName={name.trim()}
                      variant="compact"
                      authorizationUrl={createFlow.authorizationUrl}
                      onCancel={createFlow.cancel}
                      dataTestId="mcp-server-create-sign-in"
                    />
                  )}
                </div>
              )}
              {createFlow.error !== '' && (
                <Notice
                  intent="destructive"
                  title={
                    createFlow.savedServerId === null
                      ? "Couldn't add the server"
                      : "Couldn't connect"
                  }
                  data-testid="mcp-server-create-error"
                >
                  <span className={REPLAY_BLOCK_CLASS}>{createFlow.error}</span>
                  {createFlow.savedServerId !== null && (
                    <>
                      {' '}
                      The server is saved, so you can try again or close this.
                    </>
                  )}
                </Notice>
              )}
              <CustomMcpAdvanced
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
                hint={customMcpAdvancedHint([
                  serverType === 'command' && 'Command',
                  description.trim() !== '' && 'Description',
                  scopeTouched &&
                    (effectiveScope === 'cloud'
                      ? 'Cloud account'
                      : 'This device'),
                  authHandler !== '' && 'Auth handling',
                  Object.keys(headers).length === 1 && '1 header',
                  Object.keys(headers).length > 1 &&
                    `${Object.keys(headers).length} headers`,
                  oauthForm.enabled && 'OAuth',
                  configs.length > 1 && `${configs.length} configurations`,
                ])}
                dataTestId="mcp-server-advanced"
              >
                {serverTypeField}
                {descriptionField}
                {commandScopeField}
                {serverType === 'http' && httpAdvancedFields}
                {configurationsField}
              </CustomMcpAdvanced>
            </>
          )}

          {!customCreate && configurationsField}
        </EntityEditModalContent>
      </DialogModal>
      {confirmMoveToDevice && (
        <McpMoveToDeviceDialog
          serverName={name.trim() || (cloudConnection?.displayName ?? '')}
          signInAgain={
            !cloudToken.trim() &&
            !oauthForm.enabled &&
            !hasAnyAuthTokenConfigured(configs)
          }
          {...(moveDropsStoredHeaders
            ? {
                storedHeadersChoice: {
                  known: storedHeadersKnown,
                  confirmed: moveWithoutStoredHeaders,
                  onChange: setMoveWithoutStoredHeaders,
                },
              }
            : {})}
          onConfirm={(): void => void moveToDevice()}
          onClose={(): void => setConfirmMoveToDevice(false)}
        />
      )}
      {confirmMoveToCloud && (
        <McpMoveToCloudDialog
          serverName={name.trim()}
          tokenMoves={
            cloudToken.trim().length > 0 || savedCloudToken !== undefined
          }
          dataTestId="mcp-move-to-cloud-dialog"
          confirmTestId="mcp-move-to-cloud-confirm"
          onConfirm={(): void => {
            const move = pendingMoveToCloud.current;
            pendingMoveToCloud.current = null;
            setConfirmMoveToCloud(false);
            if (move) void move();
          }}
          onClose={(): void => {
            pendingMoveToCloud.current = null;
            setConfirmMoveToCloud(false);
          }}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// McpServerDetailOverlay (read-only detail view for UnifiedTable "View" action)
// ---------------------------------------------------------------------------

export function McpServerDetailOverlay({
  shareAction,
  serverId,
  configId,
  onBack,
}: {
  shareAction?: MarketplaceShareAction;
  serverId: string;
  /**
   * Which configuration of an account server to open. Account rows for one
   * key share the server id, so without it the default connection opens.
   */
  configId?: string;
  onBack: () => void;
}): JSX.Element {
  const accountEnabled = useFeatureFlagsStore((state): boolean =>
    state.isEnabled(CLIENT_FEATURE_FLAGS.canopySharedMcpAccountConnections.key),
  );
  const [accountConnection, setAccountConnection] =
    useState<AccountMcpConnection | null>(null);
  const [server, setServer] = useState<McpServerDataView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    setAccountConnection(null);
    setServer(null);

    void runCancellableModalLoad(
      async (): Promise<void> => {
        // Account rows are keyed by server key, so only the merged index
        // tells an account row from a device server.
        const accountConnectionId = accountEnabled
          ? findAccountMcpRow(
              (await window.mcpServers.loadIndex()).servers,
              serverId,
              configId,
            )?.accountConnectionId
          : undefined;
        if (cancelled) return;
        if (accountConnectionId) {
          const result =
            await window.mcpServers.getAccountConnection(accountConnectionId);
          if (!cancelled) setAccountConnection(result);
          return;
        }
        const result = await window.mcpServers.loadServer(serverId);
        if (cancelled) return;
        setServer(result.server);
      },
      {
        isCancelled: () => cancelled,
        setError,
        setLoading,
      },
    );

    return (): void => {
      cancelled = true;
    };
  }, [serverId, configId, accountEnabled]);

  if (accountConnection)
    return (
      <AccountMcpDetails
        shareAction={shareAction}
        connection={accountConnection}
        onClose={onBack}
        onSaved={(): Promise<void> => Promise.resolve()}
      />
    );

  const def = server?.definition;

  return (
    <BackDetailOverlayShell
      title={def?.name ?? 'MCP server'}
      titleId="mcp-detail-overlay-title"
      onBack={onBack}
      badgeGap="group"
      badge={
        def ? <Badge>{def.type === 'http' ? 'HTTP' : 'Command'}</Badge> : null
      }
    >
      {loading && (
        <div className="flex items-center justify-center py-12">
          <p className="text-s fg-secondary">Loading&hellip;</p>
        </div>
      )}

      {error && <Notice intent="destructive">{error}</Notice>}

      {def && !loading && (
        <Stack gap="group">
          <InstalledEntryStatusSection
            entry={{
              state: 'installed',
              name: def.name,
              ref: { type: 'local-mcp', serverId },
            }}
            onUninstalled={onBack}
          />
          {/* Description */}
          {def.description && (
            <p className="text-s fg-secondary">{def.description}</p>
          )}

          {/* Connection details */}
          <Surface variant="group">
            <div className="px-4 py-3">
              <McpConnectionFacts
                type={def.type === 'command' ? 'command' : 'http'}
                url={def.type === 'http' ? def.url : undefined}
                commandLine={
                  def.type === 'command' && def.command
                    ? `${def.command}${
                        def.args && def.args.length > 0
                          ? ` ${def.args.join(' ')}`
                          : ''
                      }`
                    : undefined
                }
                oauth={def.type === 'http' ? Boolean(def.oauth) : undefined}
              />
            </div>
          </Surface>

          {/* Configurations */}
          <StandaloneConfigsSection
            loading={false}
            error={null}
            serverData={server}
          />
        </Stack>
      )}
    </BackDetailOverlayShell>
  );
}
