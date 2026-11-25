import {
  PIPELINE_PACKAGE_CLIENT_VERSION,
  PIPELINE_PACKAGE_VERSION_HEADER,
} from '@canopy/protocol/pipelines';
import { createHash } from 'node:crypto';
import { isSea } from 'node:sea';
import { z } from 'zod';
import { BRAND } from '@canopy/brand/current';
import {
  getBrandEnv,
  brandEnvName,
  brandEnvCandidates,
} from '@canopy/execution-engine/brand/env';
import type { WorkOwner } from '@canopy/protocol/llm-gateway';
import {
  normalizeOrgEnforcedSettingsWithStatus,
  modelGatewayAccountFields,
} from '../../lib/org-enforced-parsing';
import {
  isModelBlocked,
  modelPolicyForOwner,
  resolveModelPolicyIndex,
} from '../../lib/model-policy';
import {
  gatewayRequirementForOwner,
  isModelExcludedByGatewayRequirement,
  resolveModelGatewayIndex,
} from '../../lib/org-model-gateway';

declare const __CANOPY_CLOUD_BASE_URL__: string | undefined;

const accountSchema = z
  .object({
    personalOrganizationId: z.string().uuid().optional(),
    account: z.object({ id: z.string().min(1) }).passthrough(),
    capabilities: z.array(z.string()),
    organizations: z.array(z.object({ id: z.string().min(1) }).passthrough()),
    enforcedSettings: z.array(
      z.object({
        organizationId: z.string().uuid(),
        organizationName: z.string(),
        policies: z.array(z.object({ kind: z.string() }).passthrough()),
      }),
    ),
  })
  .passthrough();

export type CliAccountSnapshot = z.infer<typeof accountSchema>;

/** Hosted authority using the CLI's existing explicit cloud-key credential.
 * Never reads or rewrites Electron's encrypted account replica.
 */
export class CliOpenCodeAccount {
  readonly origin: string;
  readonly identity: string;
  private accountId: string | undefined;
  private readonly apiKey: string;

  constructor(credentials: { origin: string; apiKey: string }) {
    const url = new URL(credentials.origin);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== '/' ||
      (url.protocol !== 'https:' &&
        !(
          url.protocol === 'http:' &&
          ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        ))
    )
      throw new Error('The CLI cloud origin is invalid.');
    if (!credentials.apiKey.startsWith('csk_'))
      throw new Error('The CLI cloud key is invalid.');
    this.apiKey = credentials.apiKey;
    this.origin = url.origin;
    this.identity = createHash('sha256')
      .update(JSON.stringify([this.origin, credentials.apiKey]))
      .digest('hex');
  }

  async request(path: string, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!path.startsWith('/api/') || path.includes('\\') || path.includes('#'))
      throw new Error('Invalid account request.');
    const url = new URL(path, this.origin);
    if (url.origin !== this.origin) throw new Error('Invalid account request.');
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: 'application/json',
        [PIPELINE_PACKAGE_VERSION_HEADER]: String(
          PIPELINE_PACKAGE_CLIENT_VERSION,
        ),
      },
      redirect: 'error',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `The account service refused the request (${response.status}).`,
      );
    }
    if (!response.body) throw new Error('The account response is empty.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 2 * 1024 * 1024)
          throw new Error('The account response is too large.');
        chunks.push(next.value);
      }
      signal.throwIfAborted();
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      return value;
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async snapshot(signal: AbortSignal): Promise<CliAccountSnapshot> {
    const account = accountSchema.parse(
      await this.request(`/api/v1/${BRAND.web.apiNamespace}/account`, signal),
    );
    if (this.accountId !== undefined && this.accountId !== account.account.id)
      throw new Error('The account changed during this workflow.');
    this.accountId = account.account.id;
    return account;
  }

  async assertModel(
    model: string,
    owner: WorkOwner,
    signal: AbortSignal,
  ): Promise<CliAccountSnapshot> {
    const snapshot = await this.snapshot(signal);
    if (
      owner.kind === 'organization' &&
      !snapshot.organizations.some((org) => org.id === owner.organizationId)
    )
      throw new Error(
        'The workflow organization is unavailable to this account.',
      );
    const parsed = normalizeOrgEnforcedSettingsWithStatus(
      snapshot.enforcedSettings,
    );
    const policyAccount = {
      personalOrganizationId: snapshot.personalOrganizationId,
      enforcedSettings: parsed.settings,
      modelGatewayEnforcementUnavailable:
        parsed.modelGatewayEnforcementUnavailable,
      ...modelGatewayAccountFields(snapshot),
    };
    const policy = modelPolicyForOwner(
      resolveModelPolicyIndex(policyAccount),
      owner,
    );
    const requirement = gatewayRequirementForOwner(
      resolveModelGatewayIndex(policyAccount),
      owner,
    );
    if (
      isModelBlocked(model, policy) ||
      isModelExcludedByGatewayRequirement(
        model,
        requirement,
        owner,
        policyAccount.personalOrganizationId,
      )
    )
      throw new Error('The organization policy does not allow this model.');
    return snapshot;
  }

  /** Only trusted brokers call this; never include it in a worker request. */
  authorization(): string {
    return `Bearer ${this.apiKey}`;
  }
}

export function createCliOpenCodeAccount(): CliOpenCodeAccount | undefined {
  const apiKey = getBrandEnv(process.env, 'CLOUD_API_KEY')?.trim();
  if (!apiKey) return undefined;
  const origin =
    typeof __CANOPY_CLOUD_BASE_URL__ === 'string'
      ? __CANOPY_CLOUD_BASE_URL__.trim()
      : !isSea()
        ? process.env.CANOPY_CLOUD_BASE_URL?.trim()
        : undefined;
  if (!origin)
    throw new Error(
      `Configure the cloud origin before using ${brandEnvName('CLOUD_API_KEY')}.`,
    );
  return new CliOpenCodeAccount({ origin, apiKey });
}

/** Cloud credentials belong to the host, never selected executable children. */
export function stripCliAccountCredentials<T extends string | undefined>(
  environment: Readonly<Record<string, T>>,
): Record<string, T> {
  const result = { ...environment };
  const names = new Set(
    brandEnvCandidates('CLOUD_API_KEY').map((name) => name.toUpperCase()),
  );
  for (const name of Object.keys(result))
    if (names.has(name.toUpperCase())) delete result[name];
  return result;
}
