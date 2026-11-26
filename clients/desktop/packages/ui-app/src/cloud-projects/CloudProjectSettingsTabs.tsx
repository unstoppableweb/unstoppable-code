import type { ChangeEvent, JSX, ReactNode } from 'react';
import { WORKSPACE_LABEL } from '@canopy/protocol';
import { MAX_HOST_PORTS } from '@canopy/protocol/canopy-core/core';
import {
  Button,
  ChoiceField,
  DialogFormField,
  TextArea,
  TextInput,
} from '@canopy/ui-shared';
import { FieldError } from '@canopy/ui-shared/primitives/Field';
import { Divider, TextLink } from '@canopy/ui-shared/components';
import { ACTIVE_PLUGINS_LABEL } from '@canopy/ui-shared/lib';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';

// A cloud project's Network, Host and Plugins settings tabs (CAN-7053), shared
// by the web's and the desktop's project settings dialogs. Each host owns the
// state, the reads and the saves; these render it.

const PROJECT = WORKSPACE_LABEL.toLowerCase();

export interface CloudProjectNetworkTabProps {
  readonly fieldId: string;
  /** The egress hosts as typed, one per line. */
  readonly value: string;
  readonly onChange: (value: string) => void;
}

/** The hosts a project's sandbox may reach. */
export function CloudProjectNetworkTab({
  fieldId,
  value,
  onChange,
}: CloudProjectNetworkTabProps): JSX.Element {
  return (
    <DialogFormField
      label="Allowed egress hosts"
      htmlFor={fieldId}
      description="Enter up to 64 hostnames, one per line. Applies to new chats."
    >
      <TextArea
        id={fieldId}
        rows={6}
        data-testid="cloud-workspace-egress-hosts"
        value={value}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) =>
          onChange(event.target.value)
        }
      />
    </DialogFormField>
  );
}

export interface CloudProjectSandboxRoute {
  readonly port: number;
  readonly url: string;
}

/** The Host tab's live URLs, as the project's sandbox last answered. */
export type CloudProjectHostRoutes =
  | { readonly state: 'checking' }
  | { readonly state: 'unavailable' }
  | {
      readonly state: 'ready';
      readonly routes: readonly CloudProjectSandboxRoute[];
      readonly expiresAtMs: number | null;
    };

export interface CloudProjectHostTabProps {
  readonly hostModeEnabled: boolean;
  readonly onHostModeChange: (enabled: boolean) => void;
  readonly portsFieldId: string;
  /** The ports as typed, comma separated. */
  readonly portsText: string;
  readonly onPortsTextChange: (text: string) => void;
  /** Why the typed ports can't be saved, or null. */
  readonly portsError: string | null;
  /** Shown only while the stored settings have host mode on. */
  readonly routesVisible: boolean;
  readonly routes: CloudProjectHostRoutes;
  readonly onRefreshRoutes: () => void;
}

/** Host mode, its declared ports and the sandbox's forwarded URLs. */
export function CloudProjectHostTab({
  hostModeEnabled,
  onHostModeChange,
  portsFieldId,
  portsText,
  onPortsTextChange,
  portsError,
  routesVisible,
  routes,
  onRefreshRoutes,
}: CloudProjectHostTabProps): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <ChoiceField
        label={<span className="font-medium">Host</span>}
        description={`Expose ports from this ${PROJECT}'s sandbox through forwarded URLs.`}
        checked={hostModeEnabled}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          onHostModeChange(event.target.checked)
        }
        data-testid="cloud-workspace-settings-host-enabled"
      />
      <DialogFormField
        label="Ports"
        htmlFor={portsFieldId}
        description={`Comma separated, up to ${MAX_HOST_PORTS} ports.`}
      >
        <TextInput
          id={portsFieldId}
          density="settings"
          type="text"
          value={portsText}
          onChange={(event: ChangeEvent<HTMLInputElement>) =>
            onPortsTextChange(event.target.value)
          }
          disabled={!hostModeEnabled}
          placeholder="3000, 8080"
          aria-invalid={portsError !== null ? true : undefined}
          data-testid="cloud-workspace-settings-host-ports"
        />
      </DialogFormField>
      {portsError !== null && (
        <FieldError
          id="cloud-workspace-settings-host-ports-error"
          announce
          data-testid="cloud-workspace-settings-host-ports-error"
        >
          {portsError}
        </FieldError>
      )}
      <p className="text-xs fg-secondary">
        Port changes apply to the running sandbox when one is live; otherwise,
        they apply when the sandbox next starts. Forwarded URLs are public but
        unguessable, and change with each sandbox session.
      </p>
      {routesVisible && (
        <div
          className="flex flex-col gap-3"
          data-testid="cloud-workspace-settings-host-routes"
        >
          <Divider />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-s font-medium fg-primary">Live URLs</span>
              <Button
                variant="ghost"
                size="compact"
                onClick={onRefreshRoutes}
                data-testid="cloud-workspace-settings-host-routes-refresh"
              >
                Refresh
              </Button>
            </div>
            {routes.state === 'unavailable' ? (
              <p
                className="text-xs fg-secondary"
                data-testid="cloud-workspace-settings-host-routes-warning"
              >
                {`The ${PROJECT} sandbox could not be checked right now.`}
              </p>
            ) : routes.state === 'checking' ? (
              <p className="text-xs fg-secondary" role="status">
                {`Checking the ${PROJECT} sandbox…`}
              </p>
            ) : routes.routes.length > 0 ? (
              <>
                {/* Forwarded URLs are unguessable access links: kept out of
                    desktop session replay (inert on the web). */}
                <ul
                  className={`flex flex-col gap-1 ${REPLAY_BLOCK_CLASS}`}
                  data-testid="cloud-workspace-settings-host-routes-list"
                >
                  {routes.routes.map((route) => (
                    <li key={route.port} className="text-s break-all">
                      <TextLink
                        href={route.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        variant="inline"
                        data-testid={`cloud-workspace-settings-host-route-${route.port}`}
                      >
                        {route.url}
                      </TextLink>
                      <span className="text-xs fg-secondary">
                        {' '}
                        · port {route.port}
                      </span>
                    </li>
                  ))}
                </ul>
                {routes.expiresAtMs !== null && (
                  <p className="text-xs fg-secondary">
                    URLs stop working when the current sandbox session ends
                    (around {new Date(routes.expiresAtMs).toLocaleTimeString()}
                    ).
                  </p>
                )}
              </>
            ) : (
              <p
                className="text-xs fg-secondary"
                data-testid="cloud-workspace-settings-host-routes-empty"
              >
                {`The ${PROJECT} sandbox isn't running. URLs appear here while a chat session is active, and change with each session.`}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** The heading and copy around a project's default plugins picker. */
export function CloudProjectPluginsTab({
  children,
}: {
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div
      className="flex flex-col gap-3"
      data-testid="cloud-workspace-settings-plugins"
    >
      <div className="flex flex-col gap-1">
        <span className="text-s font-medium fg-primary">
          {ACTIVE_PLUGINS_LABEL}
        </span>
        <span className="text-xs fg-secondary">
          {`Choose the plugins active in all chats in this ${PROJECT}.`}
        </span>
      </div>
      {children}
    </div>
  );
}
