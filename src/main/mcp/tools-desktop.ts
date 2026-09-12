/** Platform-specific Desktop contracts share the same native execution owners. */
import type { SurfaceRegistrar } from './kernel.js';
import { registerMacOSDesktopTools } from './tools-desktop-macos.js';
import { registerWindowsDesktopTools } from './tools-desktop-windows.js';
import { registerBrowserTool } from './tools-browser.js';

export { renderBrowserAction } from './tools-browser.js';

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  if (process.platform === 'win32') registerWindowsDesktopTools(reg);
  else registerMacOSDesktopTools(reg);
  registerBrowserTool(reg);
}

