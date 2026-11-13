import type {
  DelegationModelChoice,
  DelegationModelDiscovery,
} from '@canopy/protocol/delegation/discovery';

/** No vendor unions, native handles, credentials or billing fallbacks cross this seam. */
export async function discoverDelegationModels(options: {
  modelIds: readonly string[];
  preferredModelId?: string;
  inspect: (id: string) => Promise<DelegationModelChoice>;
  signal?: AbortSignal;
}): Promise<DelegationModelDiscovery> {
  const ids = Array.from(new Set(options.modelIds));
  const boundedIds = ids.slice(0, 96);
  if (
    options.preferredModelId &&
    ids.includes(options.preferredModelId) &&
    !boundedIds.includes(options.preferredModelId)
  ) {
    boundedIds[boundedIds.length - 1] = options.preferredModelId;
  }
  const models: DelegationModelChoice[] = [];
  for (const id of boundedIds) {
    if (options.signal?.aborted) throw new Error('Model discovery cancelled');
    const model = await options.inspect(id);
    // Explicit allowlist prevents accidental projection of host routing secrets.
    models.push({
      modelId: id,
      label: model.label,
      harnessId: model.harnessId,
      runtimeKind: model.runtimeKind,
      supportedThinkingLevels: [...model.supportedThinkingLevels],
      capabilities: [...model.capabilities],
      availability: model.availability,
      authState: model.authState,
      ...(model.disabledReason ? { disabledReason: model.disabledReason } : {}),
    });
  }
  const available = models.filter(
    (model) => model.availability === 'available',
  );
  const recommended =
    available.find((model) => model.modelId === options.preferredModelId) ??
    available[0];
  return {
    models,
    ...(recommended ? { recommendedModelId: recommended.modelId } : {}),
    truncated: ids.length > models.length,
  };
}
