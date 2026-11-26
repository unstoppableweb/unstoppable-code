import { useState, type JSX } from 'react';
import { ConfirmDialog } from '@canopy/ui-shared';
import { ChoiceList, ChoiceField } from '@canopy/ui-shared/components';
import { McpActionRefusedError } from './McpServerManagement';

/** A secret of the server the person may copy; named, never its value. */
export interface McpCopySecretSlot {
  /** `definition/headers/<name>`, `config/<id>/extraHeaders/<name>` or `config/<id>/authToken`. */
  readonly slot: string;
  readonly label: string;
}

/**
 * The secrets of one HTTP server configuration that may be copied to the
 * cloud account (CAN-6176 D15): its headers, the configuration's extra
 * headers and its bearer token. Never the OAuth client secret or a command
 * server's environment, which stay on this computer.
 */
export function mcpServerCopySlots(
  server: {
    readonly definition: {
      readonly type: string;
      readonly headers?: Readonly<Record<string, unknown>>;
    };
    readonly configs: readonly {
      readonly id: string;
      readonly extraHeaders?: Readonly<Record<string, unknown>>;
      readonly authToken?: unknown;
    }[];
  },
  configId: string,
): McpCopySecretSlot[] {
  if (server.definition.type !== 'http') return [];
  const config = server.configs.find((item) => item.id === configId);
  return [
    ...Object.keys(server.definition.headers ?? {}).map((name) => ({
      slot: `definition/headers/${name}`,
      label: `${name} header`,
    })),
    ...Object.keys(config?.extraHeaders ?? {}).map((name) => ({
      slot: `config/${configId}/extraHeaders/${name}`,
      label: `${name} header`,
    })),
    ...(config?.authToken === undefined
      ? []
      : [{ slot: `config/${configId}/authToken`, label: 'Bearer token' }]),
  ];
}

export interface CopyMcpServerDialogProps {
  readonly serverName: string;
  /** The host the copy connects to, which receives the secrets. */
  readonly host: string;
  readonly slots: readonly McpCopySecretSlot[];
  /** OAuth servers sign in on the cloud; nothing of the desktop's sign-in is copied. */
  readonly signsInOnCloud: boolean;
  /** Resolves when the copy is made; rejects with a message to show. */
  readonly onCopy: (secretSlots: string[]) => Promise<void>;
  readonly onClose: () => void;
}

/**
 * Asks before copying a desktop MCP server to the cloud account (CAN-6176
 * D30). Nothing secret is preselected: each secret is a separate unchecked
 * box showing its name, never its value, and Add stays disabled until one is
 * ticked; a server with no saved secret is added without any. The desktop
 * server stays as it is (D19).
 */
export function CopyMcpServerDialog({
  serverName,
  host,
  slots,
  signsInOnCloud,
  onCopy,
  onClose,
}: CopyMcpServerDialogProps): JSX.Element {
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A refusal before the copy was attempted is shown, not recorded as a failure.
  const [refused, setRefused] = useState(false);

  const copy = async (): Promise<void> => {
    setCopying(true);
    setError(null);
    setRefused(false);
    try {
      await onCopy(
        slots.map((item) => item.slot).filter((slot) => chosen.has(slot)),
      );
      onClose();
    } catch (caught) {
      setRefused(caught instanceof McpActionRefusedError);
      setError(
        caught instanceof Error && caught.message !== ''
          ? caught.message
          : 'This server couldn’t be added to your cloud account. Try again.',
      );
    } finally {
      setCopying(false);
    }
  };

  return (
    <ConfirmDialog
      title={`Add ${serverName} to your cloud account?`}
      message={
        <div className="flex flex-col gap-3" data-testid="copy-mcp-server-body">
          <p>
            Your cloud chats get their own copy of this server, connecting to{' '}
            {host}. It stays on this computer as it is.
          </p>
          {signsInOnCloud && (
            <p>
              You sign in to it again in your browser. This computer’s sign-in
              isn’t copied.
            </p>
          )}
          {slots.length === 0 && (
            <p data-testid="copy-mcp-server-no-secrets">
              No secrets will be sent, only its address and name.
            </p>
          )}
          {slots.length > 0 && (
            <>
              <p>
                Choose the saved secrets to copy. They’re stored encrypted in
                your cloud account and sent only to {host}.
              </p>
              <ChoiceList
                aria-label="Secrets to copy"
                data-testid="copy-mcp-server-secrets"
              >
                {slots.map((item) => (
                  <ChoiceField
                    key={item.slot}
                    layout="row"
                    checked={chosen.has(item.slot)}
                    data-testid={`copy-mcp-server-secret-${item.slot}`}
                    onChange={(): void => {
                      const next = new Set(chosen);
                      if (next.has(item.slot)) next.delete(item.slot);
                      else next.add(item.slot);
                      setChosen(next);
                    }}
                    label={item.label}
                  />
                ))}
              </ChoiceList>
            </>
          )}
        </div>
      }
      confirmLabel="Add to cloud"
      busyLabel="Adding…"
      busy={copying}
      confirmDisabled={slots.length > 0 && chosen.size === 0}
      {...(refused
        ? { errorMessage: error, errorRecordingDisabled: true as const }
        : { errorMessage: error, errorSource: 'mcp-server-copy' })}
      dataTestId="copy-mcp-server-dialog"
      confirmTestId="copy-mcp-server-confirm"
      cancelTestId="copy-mcp-server-cancel"
      onConfirm={(): void => {
        void copy();
      }}
      onCancel={(): void => {
        if (!copying) onClose();
      }}
    />
  );
}
