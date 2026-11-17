/* eslint-disable @typescript-eslint/no-require-imports -- Isolated Electron qualification entry. */
const { app } = require('electron');
const assert = require('node:assert/strict');
const { mkdirSync } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const [root, phase] = process.argv.slice(-2);
assert(path.isAbsolute(root));
assert.match(path.basename(root), /^browser-r8-/);
mkdirSync(path.join(root, 'user-data'), { recursive: true });
mkdirSync(path.join(root, 'session-data'), { recursive: true });
process.env.CANOPY_DATA_DIR = path.join(root, 'data');
process.env.CANOPY_SECURE_DATA_DIR = path.join(root, 'secure-data');
globalThis.__CANOPY_E2E__ = false;
app.setPath('userData', path.join(root, 'user-data'));
app.setPath('sessionData', path.join(root, 'session-data'));
app.on('window-all-closed', () => {});

app
  .whenReady()
  .then(async () => {
    require('tsx/cjs');
    const {
      BrowserProfileService,
    } = require('../../../../src/main/browser/browser-profile-service.ts');
    const {
      disposeResourceMonitorService,
    } = require('../../../../src/main/resource-monitor/index.ts');
    const service = new BrowserProfileService(
      path.join(root, 'data'),
      app.getPath('sessionData'),
    );
    if (phase === 'loaded') {
      const profile = await service.repository.createNamed('create', {
        displayName: 'R8 synthetic',
      });
      const directory = await service.storageDirectory(
        profile.profileId,
        profile.storageGeneration,
      );
      assert.equal(
        await service.existingSession(
          profile.profileId,
          profile.storageGeneration,
        ),
        undefined,
      );
      await fs.mkdir(directory, { recursive: true });
      const native = await service.existingSession(
        profile.profileId,
        profile.storageGeneration,
      );
      assert(native);
      assert.equal(path.resolve(native.storagePath), directory);
      await native.cookies.set({
        url: 'https://r8.invalid/',
        name: 'r8',
        value: 'synthetic',
      });
      assert.equal((await native.cookies.get({ name: 'r8' })).length, 1);
      await service.repository.deleteNamed(
        'delete',
        profile.profileId,
        profile.metadataRevision,
      );
      await service.purgeRetired();
      assert.equal(service.cleanupErrors.size, 0);
      assert.equal((await native.cookies.get({ name: 'r8' })).length, 0);
      assert.equal((await fs.stat(directory)).isDirectory(), true);
      assert.equal((await service.repository.getCleanupJobs()).length, 1);
      await service.purgeRetired();
      assert.equal((await service.repository.getCleanupJobs()).length, 1);
      await fs.writeFile(
        path.join(root, 'locator.json'),
        JSON.stringify({ directory }),
      );
    } else {
      assert.equal(phase, 'unloaded');
      const { directory } = JSON.parse(
        await fs.readFile(path.join(root, 'locator.json'), 'utf8'),
      );
      assert.equal((await service.repository.getCleanupJobs()).length, 1);
      await service.purgeRetired();
      assert.equal(service.cleanupErrors.size, 0);
      assert.equal((await service.repository.getCleanupJobs()).length, 0);
      await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    }
    await fs.writeFile(
      path.join(root, `${phase}.json`),
      JSON.stringify({
        phase,
        passed: true,
        platform: process.platform,
        versions: process.versions,
      }),
    );
    disposeResourceMonitorService();
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });
