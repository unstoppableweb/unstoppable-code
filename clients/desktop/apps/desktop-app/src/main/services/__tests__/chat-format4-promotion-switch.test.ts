/**
 * The production chat repository's format 4 construction seam (CAN-6192):
 * normal builds handle format 4 and promote only while
 * `canopy-desktop-chat-format4-promotion` is on; E2E builds keep their
 * CANOPY_E2E_CHAT_FORMAT4 opt-in.
 */
import { ChatStateService } from '../chat-state-service';
import type * as RepositoryModule from '../chat-state-v2-repository';
import type { ChatStateV2RepositoryOptions } from '../chat-state-v2-repository';
import { isE2eBuild } from '../../lib/e2e-gate';
import { isChatFormat4PromotionEnabled } from '../chat-format4-promotion-flag';

const mockOptions: ChatStateV2RepositoryOptions[] = [];
jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: jest.fn() }));
jest.mock('../chat-format4-promotion-flag', () => ({
  isChatFormat4PromotionEnabled: jest.fn(),
}));
jest.mock('../chat-state-v2-repository', () => {
  const actual = jest.requireActual<typeof RepositoryModule>(
    '../chat-state-v2-repository',
  );
  return {
    ...actual,
    ChatStateV2Repository: class extends actual.ChatStateV2Repository {
      constructor(options: ChatStateV2RepositoryOptions) {
        super(options);
        mockOptions.push(options);
      }
    },
  };
});

const scope = { projectId: 'project', worktreeId: 'scope' };

describe('the production chat repository format 4 construction seam', () => {
  const original = process.env.CANOPY_E2E_CHAT_FORMAT4;
  afterEach(() => {
    if (original === undefined) delete process.env.CANOPY_E2E_CHAT_FORMAT4;
    else process.env.CANOPY_E2E_CHAT_FORMAT4 = original;
    mockOptions.length = 0;
    jest.mocked(isChatFormat4PromotionEnabled).mockReset();
  });

  function construct(
    e2e: boolean,
    option: string | undefined,
  ): ChatStateV2RepositoryOptions {
    jest.mocked(isE2eBuild).mockReturnValue(e2e);
    if (option === undefined) delete process.env.CANOPY_E2E_CHAT_FORMAT4;
    else process.env.CANOPY_E2E_CHAT_FORMAT4 = option;
    // Do not inject a repository: exercise the real construction seam.
    new ChatStateService();
    expect(mockOptions).toHaveLength(1);
    const [options] = mockOptions;
    if (!options) throw new Error('No repository was constructed');
    return options;
  }

  test.each([undefined, '0', '1'])(
    'a normal build handles format 4 and promotes only while the flag is on (option=%s)',
    (option) => {
      const options = construct(false, option);
      expect(options.enableFormat4).toBe(true);
      expect(options.deltaJournalIncrementalStreamMetadata).toBe(true);
      const promotion = options.format4Promotion;
      if (!promotion) throw new Error('A normal build needs a promotion gate');
      jest.mocked(isChatFormat4PromotionEnabled).mockReturnValue(false);
      expect(promotion(scope)).toBe(false);
      jest.mocked(isChatFormat4PromotionEnabled).mockReturnValue(true);
      expect(promotion(scope)).toBe(true);
    },
  );

  test.each([
    [undefined, false],
    ['0', false],
    ['1', true],
  ])(
    'an E2E build keeps its opt-in (option=%s enables=%s)',
    (option, enabled) => {
      const options = construct(true, option);
      expect(options.enableFormat4 === true).toBe(enabled);
      expect(options.deltaJournalIncrementalStreamMetadata === true).toBe(
        enabled,
      );
      expect(options.format4Promotion).toBeUndefined();
      expect(isChatFormat4PromotionEnabled).not.toHaveBeenCalled();
    },
  );
});
