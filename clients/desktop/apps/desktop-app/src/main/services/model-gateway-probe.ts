import { normalizeModelGatewayBaseUrl } from '@canopy/protocol/canopy-server';
import {
  gatewayDiscoveryHeaders,
  MODEL_GATEWAY_DISCOVERY_MAX_BYTES,
  parseGatewayModelList,
  type AiGatewayConnectionResult,
} from '@canopy/protocol/model-gateway/discovery';
import { getMockLlmOrigin } from '../lib/e2e-mock-control-plane';

/** Main's existing compatibility transport supports private/VPN HTTPS gateways. */
export async function probeModelGateway(input: {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<AiGatewayConnectionResult> {
  const baseUrl = normalizeModelGatewayBaseUrl(input.baseUrl);
  if (!baseUrl) return { status: 'invalid_url' };
  if (!input.apiKey.trim()) return { status: 'key_required' };
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  try {
    const requestBaseUrl = getMockLlmOrigin() ?? baseUrl;
    const response = await fetch(
      `${requestBaseUrl.replace(/\/+$/, '')}/v1/models`,
      {
        method: 'GET',
        redirect: 'error',
        signal,
        // Keyed on the real base URL, not the e2e mock origin.
        headers: gatewayDiscoveryHeaders(baseUrl, input.apiKey.trim()),
      },
    );
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      return { status: 'unauthorized' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: 'unreachable' };
    }
    if (
      Number(response.headers.get('content-length')) >
      MODEL_GATEWAY_DISCOVERY_MAX_BYTES
    ) {
      await response.body?.cancel();
      return { status: 'unreachable' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { status: 'unreachable' };
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MODEL_GATEWAY_DISCOVERY_MAX_BYTES) {
          await reader.cancel();
          return { status: 'unreachable' };
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (signal.aborted) return { status: 'unreachable' };
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return {
      status: 'connected',
      baseUrl,
      models: parseGatewayModelList(body),
    };
  } catch {
    return { status: 'unreachable' };
  }
}
