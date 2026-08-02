/*
 * Runs in a disposable Electron process. It never reads or writes a user
 * credential; the only plaintext is an in-memory probe used to verify that
 * Electron's Windows DPAPI wrapper can actually round-trip after app ready.
 */
const { app, safeStorage } = require('electron');
const path = require('path');

const probe = 'podplayer-ai-safe-storage-runtime-probe-v1';
const userDataArgument = process.argv.find(arg =>
  arg.startsWith('--podplayer-safe-storage-user-data=')
);

if (userDataArgument) {
  app.setPath(
    'userData',
    path.resolve(userDataArgument.split('=').slice(1).join('='))
  );
}

async function main() {
  await app.whenReady();

  let availability = null;
  let roundTrip = false;
  let failure = false;
  const hasSafeStorage = !!safeStorage;
  const hasEncryptString = !!(
    safeStorage && typeof safeStorage.encryptString === 'function'
  );
  const hasDecryptString = !!(
    safeStorage && typeof safeStorage.decryptString === 'function'
  );

  try {
    if (
      safeStorage &&
      typeof safeStorage.isEncryptionAvailable === 'function'
    ) {
      availability = safeStorage.isEncryptionAvailable();
    }
  } catch (e) {
    failure = true;
  }

  try {
    if (hasEncryptString && hasDecryptString) {
      const encrypted = safeStorage.encryptString(probe);
      roundTrip = safeStorage.decryptString(encrypted) === probe;
    }
  } catch (e) {
    failure = true;
  }

  console.log(
    JSON.stringify({
      appReady: app.isReady(),
      platform: process.platform,
      electron: process.versions.electron,
      hasSafeStorage,
      hasEncryptString,
      hasDecryptString,
      availability,
      roundTrip,
      failure,
    })
  );

  app.quit();
}

main().catch(() => {
  process.exitCode = 1;
  app.quit();
});
