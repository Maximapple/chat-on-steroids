import { describe, expect, it, vi } from 'vitest';

const updater = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>();
  const fake: any = {
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: true,
    allowDowngrade: true,
    channel: '',
    on: vi.fn((name: string, listener: (...args: any[]) => void) => {
      const rows = listeners.get(name) ?? [];
      rows.push(listener);
      listeners.set(name, rows);
      return fake;
    }),
    emit: (name: string, ...args: any[]) => {
      for (const listener of listeners.get(name) ?? []) listener(...args);
    },
    checkForUpdates: vi.fn(async () => null),
    quitAndInstall: vi.fn(),
    // `resetUpdaterForTests` drops the module's reference and the next `startUpdater` calls
    // `attachEvents` again, so without this the fake accumulates one live listener set per test.
    // Production attaches once per acquired updater; a test that asserts what a single listener
    // did has to start from the same place.
    resetListeners: () => listeners.clear()
  };
  return fake;
});

vi.mock('electron', () => ({ app: { isPackaged: true } }));
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }));

const {
  checkForUpdates,
  classifyUpdatePackage,
  installDownloadedUpdate,
  resetUpdaterForTests,
  safeUpdateError,
  setBeforeUpdateInstall,
  startUpdater,
  updateChannel,
  updateStatus
} = await import('../src/main/update.js');

describe('application update target policy', () => {
  // `packageFormat()` reads the live process, so a test that needs a particular installed format
  // has to state it. Without this seam the lifecycle tests silently inherited the workstation they
  // were written on: green on Windows, `phase: 'unsupported'` on the macOS and Linux release
  // runners, which is exactly what the native matrix caught. The fixture pins the package, never
  // the policy — every branch of that policy is still asserted from real inputs below.
  type PackageFixture = { name: 'nsis' | 'appimage'; platform: NodeJS.Platform; appImage: string };
  const supportedPackages: PackageFixture[] = [
    { name: 'nsis', platform: 'win32', appImage: '' },
    { name: 'appimage', platform: 'linux', appImage: '/tmp/Chat-On-Steroids-Linux-x64.AppImage' }
  ];

  const installedAs = (fixture: Pick<PackageFixture, 'platform' | 'appImage'>): (() => void) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...platform, value: fixture.platform });
    // An empty value is the same as an absent one to `classifyUpdatePackage`, and stubbing it
    // either way keeps a runner that really is inside an AppImage from leaking into a test.
    vi.stubEnv('APPIMAGE', fixture.appImage);
    return () => {
      vi.unstubAllEnvs();
      Object.defineProperty(process, 'platform', platform);
    };
  };

  it('distinguishes installed formats instead of pretending every Linux package is an AppImage', () => {
    expect(classifyUpdatePackage({ isPackaged: true, platform: 'win32', appImage: null, packageType: null })).toBe('nsis');
    expect(classifyUpdatePackage({ isPackaged: true, platform: 'linux', appImage: '/tmp/app.AppImage', packageType: null })).toBe('appimage');
    expect(classifyUpdatePackage({ isPackaged: true, platform: 'linux', appImage: null, packageType: 'deb\n' })).toBe('deb');
    expect(classifyUpdatePackage({ isPackaged: true, platform: 'linux', appImage: null, packageType: null })).toBe('unsupported');
    expect(classifyUpdatePackage({ isPackaged: true, platform: 'darwin', appImage: null, packageType: null })).toBe('unsupported');
    expect(classifyUpdatePackage({ isPackaged: false, platform: 'win32', appImage: null, packageType: null })).toBe('unsupported');
  });

  it('uses an architecture-specific Windows channel while Linux keeps its provider suffix', () => {
    expect(updateChannel('win32', 'x64')).toBe('latest');
    expect(updateChannel('win32', 'arm64')).toBe('latest-arm64');
    expect(updateChannel('linux', 'x64')).toBe('latest');
    expect(updateChannel('linux', 'arm64')).toBe('latest');
  });

  it('redacts provider URLs and local cache paths from renderer-visible failures', () => {
    expect(
      safeUpdateError(
        new Error('download C:\\Users\\Alice\\AppData\\Local\\cache\\update.exe from https://example.test/private?token=secret failed')
      )
    ).toBe('download <local path> from <release server> failed');
  });

  it.each(supportedPackages)(
    'projects check, progress, ready, and explicit-install lifecycle without install-on-quit on a $name package',
    async (fixture) => {
    const restorePackage = installedAs(fixture);
    vi.useFakeTimers();
    resetUpdaterForTests();
    updater.resetListeners();
    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('checking-for-update');
      updater.emit('update-not-available', { version: '2.0.3' });
      return null;
    });
    startUpdater();
    expect(updateStatus()).toMatchObject({ phase: 'idle', format: fixture.name, canCheck: true });
    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);

    expect((await checkForUpdates()).phase).toBe('current');
    updater.emit('update-available', { version: '2.0.4' });
    updater.emit('download-progress', { percent: 42.4 });
    expect(updateStatus()).toMatchObject({ phase: 'downloading', availableVersion: '2.0.4', percent: 42.4 });
    updater.emit('update-downloaded', { version: '2.0.4' });
    expect(updateStatus()).toMatchObject({ phase: 'ready', canInstall: true, percent: 100 });

    const preparing = vi.fn();
    setBeforeUpdateInstall(preparing);
    installDownloadedUpdate();
    expect(preparing).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    vi.useRealTimers();
    restorePackage();
  }
  );

  it('recovers the card when the installer handoff itself fails', async () => {
    // Pinned to the AppImage package the failure below actually comes from.
    const restorePackage = installedAs({ platform: 'linux', appImage: '/tmp/Chat-On-Steroids-Linux-x64.AppImage' });
    vi.useFakeTimers();
    resetUpdaterForTests();
    updater.resetListeners();
    updater.quitAndInstall.mockReset();
    startUpdater();
    updater.emit('update-downloaded', { version: '2.0.4' });
    expect(updateStatus()).toMatchObject({ phase: 'ready', canInstall: true, canCheck: true });

    // The state before the throw is the optimistic one written for a process that is about to
    // end. When the handoff fails there is no restart to complete it, so it must not be the last
    // word: it left the card reading "Restarting to install…" with both buttons dead, and only
    // restarting the app — from a broken installer — brought the updater back.
    const preparing = vi.fn();
    const recovered = vi.fn();
    setBeforeUpdateInstall(preparing, recovered);
    // How electron-updater actually reports this. `BaseUpdater.quitAndInstall` calls `install()`,
    // which catches whatever `doInstall` threw, dispatches it to `error`, and returns false —
    // `quitAndInstall` then returns void. `DebUpdater` does the same, so on Linux this is the
    // normal path. A fake that threw would exercise a branch that mostly does not happen.
    updater.quitAndInstall.mockImplementationOnce(() => {
      updater.emit('error', new Error('spawn /home/someone/.cache/chat-on-steroids/Setup.AppImage ENOENT'));
    });

    const after = installDownloadedUpdate();

    expect(preparing).toHaveBeenCalledOnce();
    // The pre-install teardown assumed this process was ending; it is not, so it is undone.
    expect(recovered).toHaveBeenCalledOnce();
    expect(after.phase).toBe('error');
    expect(after.detail).toContain('Could not start the installer');
    // The failure names the local cache path, which the renderer must never be shown.
    expect(after.detail).not.toContain('someone');
    expect(after.detail).toContain('<local path>');

    // The flags are only interesting through the button that reads them. The top bar has one
    // control, and its handler takes `canInstall` before `canCheck` — so a state that leaves
    // `canInstall` set gives the user a Retry that can only re-launch the installer that just
    // failed. For a deleted or truncated cached artifact that is an unbreakable loop. What the
    // click must actually do is re-check, which re-downloads and returns the card to `ready`.
    const clickUpdateChip = async (): Promise<'install' | 'check' | 'disabled'> => {
      const status = updateStatus();
      if (!status.canCheck && !status.canInstall) return 'disabled';
      if (status.canInstall) {
        installDownloadedUpdate();
        return 'install';
      }
      await checkForUpdates();
      return 'check';
    };

    updater.checkForUpdates.mockImplementationOnce(async () => {
      updater.emit('checking-for-update');
      updater.emit('update-available', { version: '2.0.4' });
      return null;
    });
    expect(await clickUpdateChip()).toBe('check');
    // The retry really re-entered discovery rather than the broken artifact, and `autoDownload`
    // takes it from there.
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(updateStatus().phase).toBe('available');

    updater.emit('update-downloaded', { version: '2.0.4' });
    expect(updateStatus()).toMatchObject({ phase: 'ready', canInstall: true });
    vi.useRealTimers();
    restorePackage();
  });

  it('also recovers when the handoff throws instead of dispatching', async () => {
    const restorePackage = installedAs({ platform: 'linux', appImage: '/tmp/Chat-On-Steroids-Linux-x64.AppImage' });
    vi.useFakeTimers();
    resetUpdaterForTests();
    updater.resetListeners();
    updater.quitAndInstall.mockReset();
    startUpdater();
    updater.emit('update-downloaded', { version: '2.0.4' });

    const recovered = vi.fn();
    setBeforeUpdateInstall(vi.fn(), recovered);
    // The other half of the same failure: a provider that throws rather than routing through
    // `install()`'s catch. One rollback and one published state either way, never two.
    updater.quitAndInstall.mockImplementationOnce(() => {
      throw new Error('EACCES /usr/bin/pkexec');
    });

    const after = installDownloadedUpdate();

    expect(recovered).toHaveBeenCalledOnce();
    expect(after).toMatchObject({ phase: 'error', canInstall: false, canCheck: true });
    expect(after.detail).toContain('Could not start the installer');
    expect(after.detail).toContain('<local path>');
    vi.useRealTimers();
    restorePackage();
  });

  // The other half of the policy the fixture above pins: where there is no in-app installer the
  // card must say so and stay inert, rather than offering a check that can never install. This is
  // the state the macOS release runners are in, and it is asserted from the same real inputs.
  it.each([
    { name: 'macOS', platform: 'darwin' as NodeJS.Platform, appImage: '', detail: 'macOS updates stay manual until releases are signed and notarized.' },
    { name: 'an unmarked Linux package', platform: 'linux' as NodeJS.Platform, appImage: '', detail: 'This package format does not support in-app installation.' }
  ])('leaves the update card unsupported and inert on $name', async (fixture) => {
    const restorePackage = installedAs(fixture);
    resetUpdaterForTests();
    updater.resetListeners();
    updater.checkForUpdates.mockClear();

    startUpdater();
    expect(updateStatus()).toMatchObject({
      phase: 'unsupported',
      format: 'unsupported',
      detail: fixture.detail,
      canCheck: false,
      canInstall: false
    });
    // An unsupported package never reaches the provider, so nothing can be downloaded and the
    // explicit install act has nothing to hand off.
    expect((await checkForUpdates()).phase).toBe('unsupported');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(() => installDownloadedUpdate()).toThrow('No downloaded update is ready to install.');
    restorePackage();
  });
});
