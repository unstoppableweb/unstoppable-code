import { getModelAliases, initModelAliases } from '../../types';
import { findEquivalentModel, modelIdentityKey } from '../model-identity';

describe('findEquivalentModel', () => {
  let savedAliases: Record<string, string>;

  beforeEach(() => {
    savedAliases = { ...getModelAliases() };
    initModelAliases({
      opus: 'claude-opus-5-5',
      'opus[1m]': 'claude-opus-5-5[1m]',
    });
  });

  afterEach(() => {
    initModelAliases(savedAliases);
  });

  it('matches the same model across provider spellings', () => {
    const openRouter = { id: 'gw:or:anthropic/claude-opus-4.7' };
    const requesty = { id: 'anthropic/claude-opus-5-5' };
    expect(
      findEquivalentModel('claude-opus-4-7', [
        { id: 'anthropic/claude-sonnet-4.6' },
        { id: 'anthropic/claude-opus-4.7' },
      ]),
    ).toEqual({ id: 'anthropic/claude-opus-4.7' });
    expect(findEquivalentModel('claude-opus-5-5', [requesty])).toBe(requesty);
    expect(
      findEquivalentModel('claude-opus-4-7', [
        { ...openRouter, gatewayId: 'anthropic/claude-opus-4.7' },
      ]),
    ).toEqual({ ...openRouter, gatewayId: 'anthropic/claude-opus-4.7' });
    expect(
      findEquivalentModel('Claude-Opus-4-7-20260101', [
        { id: 'anthropic/claude-opus-4.7' },
      ]),
    ).toEqual({ id: 'anthropic/claude-opus-4.7' });
    expect(
      findEquivalentModel('claude-opus-4-7-20260101[1m]', [
        { id: 'anthropic/claude-opus-4.7[1m]' },
      ]),
    ).toEqual({ id: 'anthropic/claude-opus-4.7[1m]' });
  });

  it('falls back to a context-window variant only when nothing matches exactly', () => {
    const plain = { id: 'anthropic/claude-opus-4.7' };
    const wide = { id: 'anthropic/claude-opus-4.7[1m]' };
    expect(findEquivalentModel('claude-opus-4-7[1m]', [plain])).toBe(plain);
    expect(findEquivalentModel('claude-opus-4-7[1m]', [plain, wide])).toBe(
      wide,
    );
    expect(findEquivalentModel('claude-opus-4-7', [plain, wide])).toBe(plain);
  });

  it('resolves aliases before stripping a variant', () => {
    expect(modelIdentityKey('opus[1m]', { stripVariant: true })).toBe(
      'claude-opus-5-5',
    );
    expect(
      findEquivalentModel('claude-opus-4-7', [{ id: 'opus' }]),
    ).toBeUndefined();
    expect(
      findEquivalentModel('opus', [{ id: 'anthropic/claude-opus-5.5' }]),
    ).toEqual({ id: 'anthropic/claude-opus-5.5' });
  });

  it('refuses ambiguous, near-miss and empty cases', () => {
    expect(
      findEquivalentModel('claude-opus-4-7', [
        { id: 'anthropic/claude-opus-4.7' },
        { id: 'claude-opus-4.7' },
      ]),
    ).toBeUndefined();
    // An ambiguous key tier does not fall through to the variant tier.
    expect(
      findEquivalentModel('claude-opus-4-7[1m]', [
        { id: 'anthropic/claude-opus-4.7[1m]' },
        { id: 'claude-opus-4.7[1m]' },
        { id: 'anthropic/claude-opus-4.7' },
      ]),
    ).toBeUndefined();
    for (const near of [
      'anthropic/claude-opus-4.6',
      'anthropic/claude-sonnet-4.7',
      'openai/gpt-5.5-mini',
    ]) {
      expect(
        findEquivalentModel(
          near.includes('gpt') ? 'gpt-5-5' : 'claude-opus-4-7',
          [{ id: near }],
        ),
      ).toBeUndefined();
    }
    expect(findEquivalentModel('', [{ id: '' }])).toBeUndefined();
    expect(findEquivalentModel('claude-opus-4-7', [])).toBeUndefined();
    expect(
      findEquivalentModel('ollama-llama3', [{ id: 'llama3' }]),
    ).toBeUndefined();
  });

  it('prefers an exact id and refuses a shared gateway id', () => {
    const exact = { id: 'route-a' };
    const viaGateway = { id: 'route-b', gatewayId: 'route-a' };
    expect(findEquivalentModel('route-a', [viaGateway, exact])).toBe(exact);
    expect(findEquivalentModel('route-a', [viaGateway])).toBe(viaGateway);
    expect(
      findEquivalentModel('route-a', [
        viaGateway,
        { id: 'route-c', gatewayId: 'route-a' },
      ]),
    ).toBeUndefined();
  });
});
