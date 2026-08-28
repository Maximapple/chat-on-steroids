/**
 * Windows/Linux application updates from the repository's official GitHub Releases.
 *
 * electron-updater owns release discovery, architecture selection, checksums, download cache
 * and target-specific installation. The renderer receives only this bounded state projection
 * and two named actions. macOS is deliberately excluded until its release is signed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import electronUpdater, {
  type AppUpdater,
  type ProgressInfo,
  type UpdateInfo
} from 'electron-updater';
import type { AppUpdateStatus } from '../shared/types.js';
import { logInfo, logWarn } from './logger.js';
import { APP_VERSION } from './version.js';

const FIRST_CHECK_DELAY_MS = 5_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let autoUpdater: AppUpdater | null = null;
const listeners = new Set<() => void>();
let started = false;
let checkTimer: NodeJS.Timeout | null = null;
let periodicTimer: NodeJS.Timeout | null = null;
let checking: Promise<AppUpdateStatus> | null = null;
let beforeInstall: (() => void) | null = null;
/** Undoes `beforeInstall` when the handoff it prepared for never happened. */
let installFailed: (() => void) | null = null;
/**
 * Whether an explicit install handoff is in flight.
 *
 * electron-updater does not report a failed handoff by throwing. `BaseUpdater.quitAndInstall`
 * calls `install()`, and `install()` catches whatever `doInstall` threw, dispatches it to the
 * `error` event and returns false; `quitAndInstall` then returns void as if nothing happened.
 * `DebUpdater` does the same around its install command, which makes this the *normal* path on
 * Linux. So the `error` listener, not the try/catch around the call, is where a failed install is
 * usually observed — and it needs to know an install is what failed, because that is the only
 * case where the pre-install teardown has to be undone.
 */
let installing = false;

export function classifyUpdatePackage(input: {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage: string | null;
  packageType: string | null;
}): AppUpdateStatus['format'] {
  if (!input.isPackaged) return 'unsupported';
  if (input.platform === 'win32') return 'nsis';
  if (input.platform !== 'linux') return 'unsupported';
  if (input.appImage) return 'appimage';
  return input.packageType?.trim().toLowerCase() === 'deb' ? 'deb' : 'unsupported';
}

export function updateChannel(platform: NodeJS.Platform, arch: string): string {
  return platform === 'win32' && arch === 'arm64' ? 'latest-arm64' : 'latest';
}

function packageFormat(): AppUpdateStatus['format'] {
  let packageType: string | null = null;
  try {
    packageType = readFileSync(path.join(process.resourcesPath, 'package-type'), 'utf8');
  } catch {
    // A missing marker is not permission to guess that a tar/unpacked build is a DEB.
  }
  return classifyUpdatePackage({
    isPackaged: app.isPackaged,
    platform: process.platform,
    appImage: typeof process.env.APPIMAGE === 'string' && process.env.APPIMAGE.length > 0 ? process.env.APPIMAGE : null,
    packageType
  });
}

function unsupportedDetail(format: AppUpdateStatus['format']): string {
  if (!app.isPackaged) return 'Updates are checked only by an installed package.';
  if (process.platform === 'darwin') return 'macOS updates stay manual until releases are signed and notarized.';
  if (format === 'unsupported') return 'This package format does not support in-app installation.';
  return 'Updates are unavailable on this platform.';
}

let state: AppUpdateStatus = {
  phase: 'idle',
  format: 'unsupported',
  currentVersion: APP_VERSION,
  availableVersion: null,
  percent: null,
  detail: 'Update check has not run yet.',
  canCheck: false,
  canInstall: false
};

function publish(next: AppUpdateStatus): void {
  state = next;
  for (const listener of listeners) listener();
}

function patch(next: Partial<AppUpdateStatus>): void {
  publish({ ...state, ...next });
}

export function updateStatus(): AppUpdateStatus {
  return { ...state };
}

export function onUpdateChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setBeforeUpdateInstall(
  handler: (() => void) | null,
  onFailed: (() => void) | null = null
): void {
  beforeInstall = handler;
  installFailed = onFailed;
}

function versionOf(info: UpdateInfo): string | null {
  return typeof info.version === 'string' && info.version.length <= 64 ? info.version : null;
}

/** Keep provider diagnostics useful without sending local install/cache paths to the renderer. */
export function safeUpdateError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/https?:\/\/\S+/gi, '<release server>')
    .replace(/(?:[A-Za-z]:\\|\/)(?:[^\s"'<>|]+[\\/])+[^\s"'<>|]*/g, '<local path>')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 240);
}

function attachEvents(updater: AppUpdater): void {
  updater.on('checking-for-update', () => {
    patch({ phase: 'checking', percent: null, detail: 'Checking official GitHub Releases…', canCheck: false });
  });
  updater.on('update-available', (info: UpdateInfo) => {
    patch({
      phase: 'available',
      availableVersion: versionOf(info),
      percent: 0,
      detail: `Update ${versionOf(info) ?? ''} available. Downloading…`.replace('  ', ' '),
      canCheck: false,
      canInstall: false
    });
  });
  updater.on('update-not-available', () => {
    patch({
      phase: 'current',
      availableVersion: null,
      percent: null,
      detail: 'Up to date.',
      canCheck: true,
      canInstall: false
    });
  });
  updater.on('download-progress', (progress: ProgressInfo) => {
    const percent = Number.isFinite(progress.percent) ? Math.max(0, Math.min(100, progress.percent)) : null;
    patch({
      phase: 'downloading',
      percent,
      detail: percent === null ? 'Downloading update…' : `Downloading update… ${Math.round(percent)}%`,
      canCheck: false,
      canInstall: false
    });
  });
  updater.on('update-downloaded', (info: UpdateInfo) => {
    const format = packageFormat();
    patch({
      phase: 'ready',
      availableVersion: versionOf(info) ?? state.availableVersion,
      percent: 100,
      detail: format === 'deb' ? 'Update downloaded. Install with system authentication.' : 'Update downloaded. Restart to install.',
      canCheck: true,
      canInstall: true
    });
  });
  updater.on('error', (error: Error) => {
    const detail = safeUpdateError(error);
    // A failure dispatched while an explicit install was in flight is that install failing. The
    // process is staying alive, so the window/quit latches set for a handoff that never happened
    // are released here — the published state was already right, but those latches were not.
    const duringInstall = installing;
    if (duringInstall) {
      installing = false;
      installFailed?.();
    }
    patch({
      phase: 'error',
      percent: null,
      detail: duringInstall ? `Could not start the installer: ${detail}` : `Update failed: ${detail}`,
      canCheck: true,
      canInstall: false
    });
    logWarn(`updater: ${detail}`);
  });
}

/**
 * Lazily acquires the updater so a broken install/provider module cannot break app startup.
 * A later manual or periodic check retries this boundary instead of wedging it permanently.
 */
function initializeUpdater(): boolean {
  if (autoUpdater) return true;
  try {
    const candidate = (electronUpdater as unknown as { autoUpdater: AppUpdater }).autoUpdater;
    candidate.autoDownload = true;
    // Never launch an installer from an ordinary quit or OS shutdown. The downloaded, verified
    // artifact stays in electron-updater's cache until the user chooses the explicit top-bar act.
    candidate.autoInstallOnAppQuit = false;
    // Linux's provider adds its own architecture suffix (`latest-linux-arm64.yml`). Windows
    // historically has no suffix, so its native ARM build uses an explicit official channel
    // file rather than ever offering the x64 installer to an ARM machine.
    candidate.channel = updateChannel(process.platform, process.arch);
    candidate.allowPrerelease = false;
    // Setting a channel may enable downgrade in electron-updater; restore the product policy
    // afterwards so a stale/replaced release can never roll an installed app backwards.
    candidate.allowDowngrade = false;
    attachEvents(candidate);
    autoUpdater = candidate;
    return true;
  } catch (error) {
    const detail = safeUpdateError(error) || 'updater initialization failed';
    autoUpdater = null;
    patch({
      phase: 'error',
      percent: null,
      detail: `Update service unavailable: ${detail}`,
      canCheck: true,
      canInstall: false
    });
    logWarn(`updater initialization: ${detail}`);
    return false;
  }
}

export function startUpdater(): void {
  if (started) return;
  started = true;
  const format = packageFormat();
  if (format === 'unsupported') {
    publish({
      phase: 'unsupported',
      format,
      currentVersion: APP_VERSION,
      availableVersion: null,
      percent: null,
      detail: unsupportedDetail(format),
      canCheck: false,
      canInstall: false
    });
    return;
  }

  publish({
    phase: 'idle',
    format,
    currentVersion: APP_VERSION,
    availableVersion: null,
    percent: null,
    detail: 'Update check scheduled.',
    canCheck: true,
    canInstall: false
  });
  initializeUpdater();

  checkTimer = setTimeout(() => {
    checkTimer = null;
    void checkForUpdates();
  }, FIRST_CHECK_DELAY_MS);
  checkTimer.unref?.();
  periodicTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
  periodicTimer.unref?.();
}

export async function checkForUpdates(): Promise<AppUpdateStatus> {
  if (!state.canCheck || state.format === 'unsupported') return updateStatus();
  if (!initializeUpdater() || !autoUpdater) return updateStatus();
  if (checking) return checking;
  checking = (async () => {
    try {
      await autoUpdater.checkForUpdates();
      logInfo('updater: official release check completed');
    } catch (error) {
      // electron-updater normally emits `error`; retain a useful state if a provider throws
      // without doing so (notably before the request is fully constructed).
      if (state.phase === 'checking') {
        const detail = safeUpdateError(error);
        patch({ phase: 'error', detail: `Update failed: ${detail}`, canCheck: true });
      }
    }
    return updateStatus();
  })();
  try {
    return await checking;
  } finally {
    checking = null;
  }
}

/**
 * Hands off to the downloaded installer, and survives that handoff failing.
 *
 * `quitAndInstall` is normally the last thing this process does, which is why the optimistic
 * patch below is written before the call rather than after it — there is no "after" to write in.
 * But it can throw synchronously, and does: a cached installer that was deleted or truncated
 * between download and install, an NSIS/`pkexec`/package-manager launch that the OS refuses.
 * When it did, the optimistic patch was the last word. The card sat on "Restarting to install…"
 * with both actions disabled, so the only route back to a working updater was restarting the app
 * — the state most likely to be reached by someone whose installer is broken, and the one where
 * a disabled Retry helps least.
 *
 * So the optimistic state is treated as exactly that, and rolled back on a throw — but rolled
 * back to *check*, not to install. The top bar has one button, and its handler takes `canInstall`
 * first: leaving that flag set would give the user a Retry that could only ever re-launch the same
 * installer that just failed, which for the likely causes here — a deleted or truncated cached
 * artifact — can never succeed. Clearing it makes the same button re-check, and because
 * `autoDownload` is on, that is what fetches a fresh artifact and returns the card to `ready`.
 * The detail goes through `safeUpdateError`, because these messages carry the local installer path.
 */
export function installDownloadedUpdate(): AppUpdateStatus {
  if (state.phase !== 'ready' || !state.canInstall || !autoUpdater) {
    throw new Error('No downloaded update is ready to install.');
  }
  beforeInstall?.();
  patch({ canInstall: false, canCheck: false, detail: state.format === 'deb' ? 'Starting system installer…' : 'Restarting to install…' });
  installing = true;
  try {
    autoUpdater.quitAndInstall(false, true);
  } catch (error) {
    // The rarer half: a provider that throws instead of dispatching. If the `error` listener
    // already ran it has cleared the flag and done the rollback, and this must not repeat it.
    if (installing) {
      installing = false;
      // The pre-install teardown ran on the assumption this process was about to end. It did not,
      // so the window/quit latches it set have to be released too, or closing to tray would quit.
      installFailed?.();
      const detail = safeUpdateError(error);
      patch({
        phase: 'error',
        detail: `Could not start the installer: ${detail}`,
        // Not `true`. The renderer's one button tests this flag first, so leaving it set would
        // make Retry re-run the installer that just failed and nothing else. See the note above.
        canInstall: false,
        canCheck: true
      });
      logInfo(`updater: install handoff failed (${detail})`);
    }
  } finally {
    // On the success path the process is quitting and this never matters; on any path where it
    // does not, a later unrelated provider error must not be reported as a failed install.
    installing = false;
  }
  return updateStatus();
}

export function shutdownUpdater(): void {
  if (checkTimer) clearTimeout(checkTimer);
  if (periodicTimer) clearInterval(periodicTimer);
  checkTimer = null;
  periodicTimer = null;
}

/** Test-only lifecycle seam. */
export function resetUpdaterForTests(): void {
  shutdownUpdater();
  started = false;
  checking = null;
  beforeInstall = null;
  installFailed = null;
  installing = false;
  autoUpdater = null;
  state = {
    phase: 'idle',
    format: 'unsupported',
    currentVersion: APP_VERSION,
    availableVersion: null,
    percent: null,
    detail: 'Update check has not run yet.',
    canCheck: false,
    canInstall: false
  };
}
