import './styles/app-styles';
import { createRoot } from 'react-dom/client';
import { CanopyClientProvider } from '@canopy/app-state';
import { CreditsPurchaseProvider } from '@canopy/ui-app/credits';
import { ipcCanopyClient } from '@/client/ipc-canopy-client';
import { brand } from '@/lib/brand';
import { applyBrandDocumentHead } from '@/lib/brandDocumentHead';
import { applyTheme, installBrandDefaultTheme } from '@/lib/theme';
import { ComposerStatusLabPage } from '@/components/dev/ComposerStatusLabPage';
import { seedComposerLabModels } from '@/components/dev/composerLabModels';
import {
  ComposerStatesGallery,
  GALLERY_FILE_CONTENTS,
  GALLERY_FILE_PREVIEWS,
} from '@/components/dev/ComposerStatesGallery';

// The lab runs in a plain browser: the + menu's marketplace hook looks for
// the preload bridge's `plugins` API before subscribing, so give it an empty
// one. Every other bridge call in the composer is gated off by the lab.
if (!('plugins' in window)) {
  Object.defineProperty(window, 'plugins', { value: {}, configurable: true });
}
// The model picker reads a few preferences through the preload bridge: stand
// in for them with a signed-in Claude and Codex and a Cursor that is not set
// up yet, so its harness tab offers to connect.
if (!('api' in window)) {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<{ cursorEnabled: boolean }> =>
        Promise.resolve({ cursorEnabled: false }),
      onPreferencesChanged: (): (() => void) => () => undefined,
      loadCanopyCloudAccount: (): Promise<null> => Promise.resolve(null),
      // The states gallery's attachment tiles show their files.
      readFilePreview: ({
        absolutePath,
      }: {
        absolutePath: string;
      }): Promise<object> => {
        const filename = absolutePath.split('/').pop() ?? absolutePath;
        const preview = GALLERY_FILE_PREVIEWS[absolutePath] ?? {
          kind: 'unsupported',
          content: '',
        };
        return Promise.resolve({
          ...preview,
          filename,
          sizeBytes: 1_024,
          truncated: false,
          modifiedAtMs: 0,
        });
      },
      // The states gallery's code-selection chips check their file.
      readFileContent: ({
        absolutePath,
      }: {
        absolutePath: string;
      }): Promise<{ kind: 'text'; content: string }> => {
        const content = GALLERY_FILE_CONTENTS[absolutePath];
        return content === undefined
          ? Promise.reject(new Error('Not in the lab'))
          : Promise.resolve({ kind: 'text', content });
      },
    },
  });
}
seedComposerLabModels();

applyBrandDocumentHead(brand);
installBrandDefaultTheme();
const labParams = new URLSearchParams(window.location.search);
applyTheme('default', labParams.get('theme') === 'light' ? 'light' : 'dark');

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element not found');
}

// `?view=states` shows every composer state side by side. The model picker's
// recovery reads the purchase mode, so both views sit inside a purchase
// provider; with no client (the lab has no bridge) nothing can be bought.
createRoot(rootElement).render(
  <CreditsPurchaseProvider client={null}>
    {labParams.get('view') === 'states' ? (
      // The code-selection chips read the file viewer's store.
      <CanopyClientProvider client={ipcCanopyClient}>
        <ComposerStatesGallery />
      </CanopyClientProvider>
    ) : (
      <ComposerStatusLabPage />
    )}
  </CreditsPurchaseProvider>,
);
