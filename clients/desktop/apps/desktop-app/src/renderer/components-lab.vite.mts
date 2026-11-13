import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const configDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(configDir, '../../../..');
const selectedBrandId = process.env.CANOPY_BRAND ?? 'canopy';

/**
 * Localhost components library (`ComponentsLabPage`): every unified shared
 * component with its variants, sizes and states, plus the list of UI still
 * waiting to be unified. `pnpm exec vite --config
 * apps/desktop-app/src/renderer/components-lab.vite.mts`, then
 * http://127.0.0.1:5188/components-lab.html (`?component=<id>` opens one
 * component, `?theme=dark` starts in dark).
 */
export default defineConfig({
  root: configDir,
  appType: 'spa',
  publicDir: false,
  server: {
    host: '127.0.0.1',
    port: 5188,
    strictPort: true,
    open: '/components-lab.html',
    fs: {
      allow: [repoRoot],
    },
    // Build output, specs, and Playwright artifacts never affect the lab.
    watch: {
      ignored: [
        '**/out/**',
        '**/out-e2e/**',
        '**/.playwright/**',
        '**/tests/**',
        '**/apps/web/**',
        '**/public/**',
      ],
    },
  },
  esbuild: {
    jsx: 'automatic',
  },
  plugins: [
    {
      // The lab's stageshow stages move an authored cursor, not the real
      // pointer: the kit marks what it hovers `data-hover` and what it
      // presses `data-pressed`. Matching those marks wherever the compiled
      // CSS says `:hover` or `:active` lets the real shared components show
      // their own hover and press under it. Lab only; production CSS never
      // passes through this config.
      name: 'components-lab-scripted-pointer',
      enforce: 'post',
      transform(code, id) {
        if (!/\.css(?:$|\?)/.test(id)) return null;
        // An escaped colon is part of a class name, never a pseudo-class.
        return code
          .replace(/(?<!\\):hover\b/g, ':is(:hover,[data-hover])')
          .replace(/(?<!\\):active\b/g, ':is(:active,[data-pressed])');
      },
    },
    {
      name: 'components-lab-root',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const path = req.url?.split('?')[0];
          if (path === '/' || path === '/index.html') {
            res.statusCode = 302;
            res.setHeader('Location', '/components-lab.html');
            res.end();
            return;
          }
          next();
        });
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(configDir, 'src'),
      '@canopy/protocol': resolve(repoRoot, 'packages/protocol/src'),
      '@canopy/plugin-interop': resolve(
        repoRoot,
        'packages/plugin-interop/src',
      ),
      '@canopy/pipeline-interop': resolve(
        repoRoot,
        'packages/pipeline-interop/src',
      ),
      '@canopy/app-core': resolve(repoRoot, 'packages/app-core/src'),
      '@canopy/app-state': resolve(repoRoot, 'packages/app-state/src'),
      '@canopy/desktop-shared': resolve(
        repoRoot,
        'packages/desktop-shared/src',
      ),
      '@canopy/desktop-instrumentation': resolve(
        repoRoot,
        'packages/desktop-instrumentation/src',
      ),
      '@canopy/ui-shared': resolve(repoRoot, 'packages/ui-shared/src'),
      '@canopy/ui-rich': resolve(repoRoot, 'packages/ui-rich/src'),
      '@canopy/ui-app': resolve(repoRoot, 'packages/ui-app/src'),
      '@canopy/brand/current': resolve(
        repoRoot,
        '.cache/brand',
        selectedBrandId,
        'desktop-brand.ts',
      ),
      '@canopy/brand/web': resolve(repoRoot, '.cache/brand/web-brands.ts'),
      '@repo/package.json': resolve(repoRoot, 'package.json'),
      'composer-lab/gateway-catalog': resolve(
        repoRoot,
        'apps/desktop-app/tests/electron/fixtures/pr3519-gateway-catalog.json',
      ),
    },
  },
});
