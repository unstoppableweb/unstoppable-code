// Golden (CAN-7640): an open chat's gateway route reads the stored key on
// every request, so after a key rotation the very next request carries the
// new key without restarting the session. Drives the real loopback broker
// against a local upstream that records each request's credential.
import { createServer, type Server } from 'node:http';
import { resolveGatewayModelEntry } from '@canopy/execution-engine/lib/gateway-model-availability';
import {
  loadModelsFromPackageJson,
  updateOrgGatewayModelCatalog,
} from '../../lib/model-config';

const TEAM = '44444444-4444-4444-8444-444444444444';
const BASE_URL = 'https://team-gateway.example/api';
const stored = { apiKey: 'sk-old', updatedAt: '2026-11-23T00:00:00.000Z' };

jest.mock('../../lib/model-gateway-credential-store', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../lib/model-gateway-credential-store',
  ),
  loadModelGatewayCredential: jest.fn(() =>
    Promise.resolve({
      organizationId: TEAM,
      apiKey: stored.apiKey,
      baseUrlAtSave: BASE_URL,
      updatedAt: stored.updatedAt,
    }),
  ),
}));

import { buildBrokeredOrgGatewayClaudeEnv } from '../ai-credits-routing';

const seen: string[] = [];
let upstream: Server;
let upstreamUrl = '';

beforeAll(async () => {
  loadModelsFromPackageJson();
  updateOrgGatewayModelCatalog([
    {
      organizationId: TEAM,
      organizationName: 'Team',
      baseUrl: BASE_URL,
      models: [
        {
          id: 'team-claude',
          gatewayId: 'vendor/team-claude',
          label: 'Team Claude',
          harness: 'claude',
          contextWindow: 200_000,
          supportedThinkingLevels: [],
          toolSchemaProfile: 'standard',
        },
      ],
      promptCachePassthrough: true,
    },
  ]);
  upstream = createServer((request, response) => {
    seen.push(String(request.headers.authorization));
    request.resume();
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"id":"msg","type":"message","content":[]}');
    });
  });
  await new Promise<void>((resolve) => {
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  if (address === null || typeof address === 'string')
    throw new Error('upstream has no port');
  upstreamUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    upstream.close(() => resolve());
  });
});

async function send(env: Record<string, string>): Promise<number> {
  const response = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.ANTHROPIC_AUTH_TOKEN}`,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'vendor/team-claude',
      max_tokens: 8,
      messages: [],
    }),
  });
  await response.text();
  return response.status;
}

describe('gateway key rotation in an open chat', () => {
  it('sends the rotated key on the next request through the same route', async () => {
    const entry = resolveGatewayModelEntry('team-claude');
    if (!entry) throw new Error('gateway model not seeded');
    const env = await buildBrokeredOrgGatewayClaudeEnv(
      entry,
      'session-open-chat',
      upstreamUrl,
    );
    expect(await send(env)).toBe(200);
    stored.apiKey = 'sk-new';
    stored.updatedAt = '2026-11-23T01:00:00.000Z';
    expect(await send(env)).toBe(200);
    expect(seen).toEqual(['Bearer sk-old', 'Bearer sk-new']);
  });
});
