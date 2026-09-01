/**
 * The Desktop connector: seeing and driving the native desktop.
 *
 * Two tools, and they are deliberately not on Core. Desktop control is gated on permissions
 * most users leave off, its schemas are the largest this app publishes, and the majority of
 * coding sessions never touch the desktop — so folding it into Core would put its weight
 * into every no-query discovery of the coding surface for a capability nobody asked for.
 * Separate connector, separate discovery boundary (`docs/tool-surface.md` §6.4).
 *
 * The split between the two is looking versus touching, and it is load-bearing rather than
 * cosmetic: `observe` never requires the foreground and can never fail for lack of it, while
 * `computer` is the only tool allowed to demand focus. That asymmetry is what makes the
 * recovery path work — when something else steals focus, you can still look, see what took
 * it, and act on that.
 */

import { z } from 'zod';
import {
  ComputerError,
  DEFAULT_SCREENSHOT_WIDTH,
  MAX_SCREENSHOT_WIDTH,
  actAndCapture,
  activeWindow,
  findUi,
  getWindowState,
  listWindows,
  screenshot,
  waitForWindow,
  type Action,
  type VerificationSpec
} from '../computer/index.js';
import { logInfo } from '../logger.js';
import { currentCall, noteCount, noteDetail } from './call-context.js';
import { runBrowserCommand } from '../browser-control.js';
import {
  cropArg,
  fail,
  guard,
  imageCoordinateArg,
  mouseButtonArg,
  ok,
  pointArg,
  windowIdArg,
  type SurfaceRegistrar,
  type ToolContent
} from './kernel.js';

const DEFAULT_WINDOW_RESULTS = 60;
const MAX_WINDOW_RESULTS = 100;
const MAX_CLIPBOARD_LINE_CHARS = 16_000;
const MAX_CLIPBOARD_OUTPUT_CHARS = 64_000;
const MAX_MCP_RESPONSE_BYTES = 8 * 1024 * 1024;
const MCP_RESPONSE_ENVELOPE_RESERVE_BYTES = 64 * 1024;

/** The image and its observation text share one final MCP response budget. */
function desktopImageResult(text: string, data: string): { content: ToolContent[] } {
  const result = {
    content: [
      { type: 'text', text } as ToolContent,
      { type: 'image', data, mimeType: 'image/png' } as ToolContent
    ]
  };
  const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  const limit = MAX_MCP_RESPONSE_BYTES - MCP_RESPONSE_ENVELOPE_RESERVE_BYTES;
  if (bytes > limit) {
    throw new ComputerError(
      `DESKTOP_RESULT_TOO_LARGE: combined screenshot and control metadata are ${bytes} bytes; limit ${limit}. Retry with a smaller max_width or max_elements.`
    );
  }
  return result;
}

/**
 * Web-page control, which is a different problem from desktop control.
 *
 * The desktop driver can already click anywhere in a browser window, but it cannot see a web
 * page: Chromium keeps its renderer accessibility tree off until a real assistive client asks
 * for it, so a UIA/AX walk returns the toolbar and one opaque pane. Inside a page the desktop
 * driver has pixels and nothing else — which is exactly where refs stop being available.
 *
 * So this addresses elements by ref from `observe`, and the driver re-resolves a ref against
 * the live document immediately before acting on it. Coordinates remain available for the
 * cases refs cannot express, and they are in the screenshot's own pixels: the driver captures
 * at a scale where one image pixel is one CSS pixel is one input unit.
 */
const browserActionArg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('observe') }).strict().describe('Page, refs, screenshot.'),
  // The driver has always been able to let go of a tab and the command channel has always
  // carried the message; only this schema never offered it, so a model could take control of a
  // page and had no way to give it back. QA reached for the extension popup instead and clicked
  // it with desktop automation, which is neither reliable nor what anyone should have to do.
  z.object({ type: z.literal('detach') }).strict().describe('Let go of the tab.'),
  z.object({ type: z.literal('status') }).strict().describe('Which tab is held.'),
  z.object({ type: z.literal('navigate'), url: z.string().min(1).max(2_000) }).strict().describe('Go to a URL.'),
  z.object({ type: z.literal('back') }).strict().describe('Back.'),
  z.object({ type: z.literal('forward') }).strict().describe('Forward.'),
  z.object({ type: z.literal('reload') }).strict().describe('Reload.'),
  z.object({ type: z.literal('click_ref'), ref: z.string().min(1).max(16), button: mouseButtonArg.optional() }).strict().describe('Click a ref.'),
  z.object({ type: z.literal('set_value'), ref: z.string().min(1).max(16), text: z.string().max(20_000) }).strict().describe('Replace a field by ref.'),
  z.object({ type: z.literal('click'), x: z.number().int(), y: z.number().int(), button: mouseButtonArg.optional() }).strict().describe('Click at pixels.'),
  z.object({ type: z.literal('double_click'), x: z.number().int(), y: z.number().int() }).strict().describe('Double-click at pixels.'),
  z.object({ type: z.literal('move'), x: z.number().int(), y: z.number().int() }).strict().describe('Move the pointer.'),
  z.object({ type: z.literal('drag'), path: z.array(pointArg).min(2).max(64), button: mouseButtonArg.optional() }).strict().describe('Drag along a path.'),
  z.object({ type: z.literal('scroll'), x: z.number().int(), y: z.number().int(), scroll_x: z.number().int().optional(), scroll_y: z.number().int().optional() }).strict().describe('Scroll at a point.'),
  z.object({ type: z.literal('type'), text: z.string().max(4_000) }).strict().describe('Type into focus.'),
  z.object({ type: z.literal('keypress'), keys: z.array(z.string().max(20)).min(1).max(6) }).strict().describe('Press keys.'),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000).optional() }).strict().describe('Pause.')
]);

const computerActionArg = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click_ref'), ref: z.string().min(1).max(64) }).strict().describe('Click a control by ref from observe.'),
  z
    .object({ type: z.literal('set_value'), ref: z.string().min(1).max(64), text: z.string().max(20_000) })
    .strict()
    .describe('Set a text control’s value directly by ref.'),
  z
    .object({ type: z.literal('click'), x: imageCoordinateArg, y: imageCoordinateArg, button: mouseButtonArg.optional() })
    .strict()
    .describe('Click at image coordinates.'),
  z
    .object({
      type: z.literal('double_click'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      button: mouseButtonArg.optional()
    })
    .strict()
    .describe('Double-click at image coordinates.'),
  z.object({ type: z.literal('move'), x: imageCoordinateArg, y: imageCoordinateArg }).strict().describe('Move the pointer.'),
  z
    .object({ type: z.literal('drag'), path: z.array(pointArg).min(2).max(64), button: mouseButtonArg.optional() })
    .strict()
    .describe('Press, follow the path, release.'),
  z
    .object({
      type: z.literal('scroll'),
      x: imageCoordinateArg,
      y: imageCoordinateArg,
      scroll_x: z.number().int().min(-10_000).max(10_000).optional(),
      scroll_y: z.number().int().min(-10_000).max(10_000).optional()
    })
    .strict()
    .describe('Scroll at a point.'),
  z.object({ type: z.literal('type'), text: z.string().max(4000) }).strict().describe('Type text into target.'),
  z
    .object({ type: z.literal('keypress'), keys: z.array(z.string().max(20)).min(1).max(6) })
    .strict()
    .describe('Press keys together, e.g. ["ctrl","s"] on Windows or ["command","s"] on macOS.'),
  z.object({ type: z.literal('focus'), window: windowIdArg }).strict().describe('Bring a window to the front.'),
  z.object({ type: z.literal('wait'), ms: z.number().int().min(0).max(10_000).optional() }).strict().describe('Pause.'),
  z.object({ type: z.literal('read_clipboard') }).strict().describe('Return the clipboard text.'),
  z
    .object({ type: z.literal('write_clipboard'), text: z.string().max(100_000) })
    .strict()
    .describe('Replace the clipboard text; paste with command+v on macOS or ctrl+v on Windows/Linux.')
]);

const verificationArg = z
  .object({
    until: z.enum(['foreground', 'window_exists', 'window_closed', 'ui_appears', 'ui_disappears']),
    window: windowIdArg.optional(),
    match: z.string().min(1).max(300).optional(),
    role: z.string().min(1).max(100).optional(),
    timeout_ms: z.number().int().min(0).max(10_000).optional(),
    capture: z.enum(['on_change', 'always', 'never']).optional()
  })
  .strict();

export function registerDesktopTools(reg: SurfaceRegistrar): void {
  const { ctx, caps, exposedCaps } = reg;

  // ---------------------------------------------------------------- observe

  if (exposedCaps.screen) {
    reg.register(
      'observe',
      {
        title: 'Look at the desktop',
        description:
          'Look at the desktop without touching it. With no arguments, returns the foreground window, its picture and snapshot-scoped UI controls. ' +
          'what=windows lists windows; what=window inspects one; what=ui returns controls; wait_for waits for a title. ' +
          'Pass refs to computer click_ref/set_value and screenshot frameId with pixel coordinates. ' +
          'Window capture never focuses; a labeled visible-screen fallback may be occluded.',
        inputSchema: z
          .object({
            what: z
              .enum(['active', 'windows', 'window', 'ui'])
              .optional()
              .describe('Default active: the foreground window, its screenshot and its controls.'),
            window: windowIdArg.optional().describe('Window id for what=window or what=ui.'),
            match: z.string().max(300).optional().describe('Filter: title/process for windows, control name/role for ui.'),
            wait_for: z.string().min(1).max(300).optional().describe('Wait until a window with this title substring exists.'),
            timeout_ms: z.number().int().min(0).max(60_000).optional().describe('With wait_for. Default 10000.'),
            screenshot: z.boolean().optional().describe('Include a picture. Default true for active and window.'),
            max_width: z
              .number()
              .int()
              .min(320)
              .max(MAX_SCREENSHOT_WIDTH)
              .optional()
              .describe(`Screenshot width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
            max_elements: z
              .number()
              .int()
              .min(1)
              .max(MAX_WINDOW_RESULTS)
              .optional()
              .describe('Maximum controls or windows returned. Default 60.')
          })
          .superRefine((input, ctx) => {
            const what = input.wait_for ? (input.what ?? 'window') : (input.what ?? 'active');
            if (input.timeout_ms !== undefined && input.wait_for === undefined) {
              ctx.addIssue({ code: 'custom', path: ['timeout_ms'], message: 'timeout_ms requires wait_for' });
            }
            if (input.window !== undefined && input.wait_for !== undefined) {
              ctx.addIssue({ code: 'custom', path: ['window'], message: 'window cannot be combined with wait_for, which selects the window' });
            } else if (input.window !== undefined && what !== 'window' && what !== 'ui') {
              ctx.addIssue({ code: 'custom', path: ['window'], message: `window is not used with what=${what}` });
            }
            if (input.match !== undefined && what !== 'windows' && what !== 'ui') {
              ctx.addIssue({ code: 'custom', path: ['match'], message: 'match is only used with what=windows or what=ui' });
            }
            if ((what === 'windows' || what === 'ui') && input.screenshot === true) {
              ctx.addIssue({ code: 'custom', path: ['screenshot'], message: `screenshot=true is not used with what=${what}` });
            }
            const capturesImage = what !== 'windows' && what !== 'ui' && input.screenshot !== false;
            if (input.max_width !== undefined && !capturesImage) {
              ctx.addIssue({ code: 'custom', path: ['max_width'], message: 'max_width requires a screenshot-producing observation' });
            }
          })
          .strict(),
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
      },
      async (input) =>
        reg.guarded('screen', 'observe', async () => {
          // wait_for happens first and then answers the ordinary question about whatever it
          // found, so "wait for the installer, then look at it" is one call rather than a
          // wait followed by a second call that races the window closing again.
          let target = input.window;
          let waited: string | null = null;
          if (input.wait_for) {
            const found = await waitForWindow({
              title: input.wait_for,
              foreground: false,
              timeoutMs: input.timeout_ms
            });
            target = found.id;
            waited = `Found "${found.title}" (${found.process}) as window ${found.id}.`;
          }

          const what = input.wait_for ? (input.what ?? 'window') : (input.what ?? 'active');

          if (what === 'windows') {
            const { windows, screen } = await listWindows();
            const needle = input.match?.toLowerCase() ?? null;
            const matching = needle
              ? windows.filter(
                  (w) => w.title.toLowerCase().includes(needle) || w.process.toLowerCase().includes(needle)
                )
              : windows;
            const limit = Math.min(MAX_WINDOW_RESULTS, Math.max(1, Math.floor(input.max_elements ?? DEFAULT_WINDOW_RESULTS)));
            const shown = matching.slice(0, limit);
            noteCount(shown.length);
            logInfo(`tool observe windows (${shown.length}/${matching.length} matched, ${windows.length} total)`);
            if (shown.length === 0) return ok(prefix(waited, 'No visible windows match.'));
            const lines = shown.map(
              (w) => `${w.id}  ${w.process}  ${w.x},${w.y}  ${w.width}x${w.height}  ${w.state}  ${w.title}`
            );
            if (shown.length < matching.length) {
              lines.push(`… showing ${shown.length} of ${matching.length} matching windows; narrow match or raise max_elements`);
            }
            return ok(
              prefix(
                waited,
                `Desktop ${screen.width}x${screen.height}\nid  program  position  size  state  title\n${lines.join('\n')}`
              )
            );
          }

          if (what === 'ui' && input.match) {
            const result = await findUi({ window: target, query: input.match, maxResults: input.max_elements });
            noteCount(result.elements.length);
            if (result.elements.length === 0) {
              return ok(prefix(waited, `No controls in window ${result.window} match "${input.match}".`));
            }
            const lines = result.elements.map((element, index) => {
              const desktop = `${element.bounds.x},${element.bounds.y} ${element.bounds.width}x${element.bounds.height}`;
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const id = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              return `${index + 1}. ${element.ref} ${element.role} ${JSON.stringify(element.name)}${id} desktop=${desktop}${image}${flags}`;
            });
            return ok(prefix(waited, `window: ${result.window}\nsnapshot: ${result.snapshotId}\n${lines.join('\n')}`));
          }

          // A bare "what is on screen right now" with no window at all: cheapest possible
          // answer, and the only one that still works when there is no foreground window.
          if (what === 'active' && target === undefined && input.screenshot === false) {
            const { window, screen, foregroundIsSelf } = await activeWindow();
            if (!window) {
              // "None" and "this app" are different answers, and reporting the second as the
              // first made a deliberate refusal look like a defect. Chat On Steroids hides its
              // own windows from everything the model can see, on purpose: it must not be able
              // to drive the app that is driving it.
              const reason = foregroundIsSelf
                ? 'Chat On Steroids itself is in front. Its own windows are never exposed, so there is nothing here to act on — switch to another application first.'
                : 'No foreground window.';
              return ok(prefix(waited, `Desktop ${screen.width}x${screen.height}\n${reason}`));
            }
            return ok(prefix(waited, describeWindow(window)));
          }

          const wantsShot = what === 'ui' ? false : input.screenshot !== false;
          let state: Awaited<ReturnType<typeof getWindowState>>;
          try {
            state = await getWindowState({
              window: target,
              maxWidth: input.max_width,
              maxElements: input.max_elements,
              includeScreenshot: wantsShot,
              includeUi: true
            });
          } catch (err) {
            // "There is no foreground window" is a real native desktop state — a
            // locked screen, a shell restart, everything minimised — and it is not a reason
            // to refuse to look. Fall back to the monitor, which is the honest answer.
            if (
              target !== undefined ||
              !(err instanceof ComputerError) ||
              !err.message.startsWith('WINDOW_NOT_FOUND:')
            ) {
              throw err;
            }
            const shot = await screenshot({ maxWidth: input.max_width });
            // Why there is no window matters here as much as on the bare query, and this
            // path was missed when that one was fixed — which is why QA still saw the old
            // wording. Asked separately because the failure above tells us nothing about it.
            let selfInFront = false;
            try {
              selfInFront = (await activeWindow())?.foregroundIsSelf === true;
            } catch {
              // Best effort. This only chooses between two ways of saying the same fallback, and
              // failing to learn which would be a poor reason to fail the screenshot itself.
            }
            return desktopImageResult(
              prefix(
                waited,
                `${selfInFront ? 'Chat On Steroids itself is in front and its own windows are never exposed, so this is the whole primary monitor.' : 'No foreground window, so this is the whole primary monitor.'}\nframe: ${shot.frameId}  ${shot.width}x${shot.height} — pass frameId ${shot.frameId} with any coordinates you read off it`
              ),
              shot.data
            );
          }
          noteCount(state.elements.length);
          logInfo(`tool observe ${what} window=${state.window.id} (${state.elements.length} controls)`);

          const lines = [
            `window: ${state.window.id}  ${state.window.process}  ${state.window.state}  ${state.window.title}`,
            `bounds: ${state.window.x},${state.window.y} ${state.window.width}x${state.window.height}`
          ];
          if (state.snapshotId !== null) lines.push(`snapshot: ${state.snapshotId}`);
          if (state.screenshot) {
            lines.push(
              `frame: ${state.screenshot.frameId}  ${state.screenshot.width}x${state.screenshot.height} — pass frameId ${state.screenshot.frameId} with any coordinates you read off it`
            );
            if (state.screenshot.captureMode === 'screen_fallback') {
              lines.push(
                'note: background window capture was unavailable, so these are visible screen pixels and may show something covering the target.'
              );
            }
          }
          if (state.elements.length > 0) {
            lines.push('controls:');
            for (const element of state.elements) {
              const image = element.imageCenter ? ` image_center=${element.imageCenter.x},${element.imageCenter.y}` : '';
              const automation = element.automationId ? ` id=${JSON.stringify(element.automationId)}` : '';
              const flags = `${element.enabled ? '' : ' disabled'}${element.offscreen ? ' offscreen' : ''}`;
              lines.push(`${element.ref}  ${element.role} ${JSON.stringify(element.name)}${automation}${image}${flags}`);
            }
          } else if (state.uiUnavailable) {
            lines.push(`controls: unavailable (${state.uiUnavailable.code}) — ${state.uiUnavailable.message}`);
          } else {
            lines.push('controls: none exposed by the platform accessibility API');
          }

          const text = prefix(waited, lines.join('\n'));
          if (!state.screenshot) return ok(text);
          return desktopImageResult(text, state.screenshot.data);
        })
    );
  }

  // --------------------------------------------------------------- computer

  // Clipboard access lives here too, so a user who granted only the clipboard still gets
  // it. The individual actions are checked against their own permission when they run.
  if (exposedCaps.control || exposedCaps.clipboardRead || exposedCaps.clipboardWrite) {
    reg.register(
      'computer',
      {
        title: 'Control mouse and keyboard',
        description:
          'One desktop decision. Prefer refs; pixels need frameId. Pointer/text needs a target; system keys stay global.',
        inputSchema: z
          .object({
            actions: z.array(computerActionArg).min(1).max(20),
            frameId: z
              .number()
              .int()
              .min(1)
              .optional()
              .describe('Required for coordinate actions or captureCrop.'),
            targetWindow: windowIdArg.optional(),
            verify: verificationArg.optional(),
            captureAfter: z.boolean().optional().describe('Capture result; default on for mutations.'),
            captureWindow: windowIdArg.optional().describe('Result capture: this window.'),
            captureFull: z.boolean().optional().describe('Result capture: all monitors.'),
            captureMaxWidth: z
              .number()
              .int()
              .min(320)
              .max(MAX_SCREENSHOT_WIDTH)
              .optional()
              .describe(`Result capture width. Default ${DEFAULT_SCREENSHOT_WIDTH}.`),
            captureCrop: cropArg.optional().describe('Result crop in the input frame.')
          })
          .superRefine((input, ctx) => {
            const decisionActions = input.actions.filter((action) =>
              action.type !== 'wait' &&
              action.type !== 'read_clipboard' &&
              action.type !== 'write_clipboard' &&
              action.type !== 'move' &&
              action.type !== 'focus'
            );
            if (decisionActions.length > 1) {
              ctx.addIssue({
                code: 'custom',
                path: ['actions'],
                message: 'Use one UI-changing decision per computer call; focus/move/wait/clipboard setup may accompany it.'
              });
            }
            if (input.verify) {
              const needsWindow = input.verify.until === 'foreground';
              const needsMatch = input.verify.until !== 'foreground';
              const isUi = input.verify.until === 'ui_appears' || input.verify.until === 'ui_disappears';
              if (needsWindow && input.verify.window === undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'window'], message: 'foreground verification requires window' });
              }
              if (needsMatch && input.verify.match === undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'match'], message: `${input.verify.until} verification requires match` });
              }
              if (!isUi && input.verify.role !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'role'], message: 'role is only used by UI verification' });
              }
              if (!isUi && input.verify.until !== 'foreground' && input.verify.window !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'window'], message: 'window is only used by foreground or UI verification' });
              }
              if (input.verify.until === 'foreground' && input.verify.match !== undefined) {
                ctx.addIssue({ code: 'custom', path: ['verify', 'match'], message: 'match is not used by foreground verification' });
              }
            }
            const verifyCapture = input.verify?.capture === 'always' || input.verify?.capture === 'on_change';
            const autoCapture =
              caps.screen &&
              input.captureAfter !== false &&
              input.actions.some((action) =>
                action.type !== 'wait' && action.type !== 'read_clipboard' && action.type !== 'write_clipboard' && action.type !== 'move'
              );
            const willCapture = input.captureAfter === true || verifyCapture || autoCapture;
            const captureFields = ['captureWindow', 'captureFull', 'captureMaxWidth', 'captureCrop'] as const;
            if (!willCapture) {
              for (const field of captureFields) {
                if (input[field] !== undefined) {
                  ctx.addIssue({ code: 'custom', path: [field], message: `${field} requires captureAfter=true or verify.capture` });
                }
              }
              return;
            }
            if (input.captureCrop !== undefined && input.frameId === undefined) {
              ctx.addIssue({ code: 'custom', path: ['frameId'], message: 'frameId is required with captureCrop' });
            }
            const targetCount = Number(input.captureWindow !== undefined) + Number(input.captureFull === true) + Number(input.captureCrop !== undefined);
            if (targetCount > 1) {
              ctx.addIssue({
                code: 'custom',
                path: ['captureAfter'],
                message: 'captureWindow, captureFull=true, and captureCrop are mutually exclusive capture targets'
              });
            }
          })
          .strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async ({ actions, frameId, targetWindow, verify, captureAfter, captureWindow, captureFull, captureMaxWidth, captureCrop }) =>
        guard('computer', async () => {
          // Not reg.guarded: this tool covers two permissions. Pointer and keyboard steps
          // need "control", the clipboard steps need their own, and one blanket refusal
          // would hide which of them the user actually has to switch on.
          if (!caps.control && actions.some((a) => a.type !== 'wait' && !a.type.endsWith('_clipboard'))) {
            return fail(
              'TOOL_DISABLED: mouse and keyboard control is disabled by the current Chat On Steroids permissions. ' +
                'Ask the user to enable "Control mouse and keyboard" in the app, then retry.'
            );
          }
          const parsed: Action[] = [];
          for (const a of actions) {
            switch (a.type) {
              case 'click_ref':
                parsed.push({ type: 'click_ref', ref: a.ref });
                break;
              case 'set_value':
                parsed.push({ type: 'set_value', ref: a.ref, text: a.text });
                break;
              case 'click':
              case 'double_click':
                parsed.push({ type: a.type, x: a.x, y: a.y, button: a.button });
                break;
              case 'move':
                parsed.push({ type: 'move', x: a.x, y: a.y });
                break;
              case 'scroll':
                parsed.push({ type: 'scroll', x: a.x, y: a.y, scroll_x: a.scroll_x, scroll_y: a.scroll_y });
                break;
              case 'drag':
                parsed.push({ type: 'drag', path: a.path, button: a.button });
                break;
              case 'type':
                parsed.push({ type: 'type', text: a.text });
                break;
              case 'keypress':
                parsed.push({ type: 'keypress', keys: a.keys });
                break;
              case 'focus':
                parsed.push({ type: 'focus', window: a.window });
                break;
              case 'wait':
                parsed.push({ type: 'wait', ms: a.ms });
                break;
              case 'read_clipboard':
                // Gated here rather than by leaving the variant out of the schema: the
                // schema is cached by ChatGPT, and a tool that quietly changes shape when
                // a checkbox moves is worse than one that says plainly it is switched off.
                if (!caps.clipboardRead) {
                  return fail('TOOL_DISABLED: read_clipboard needs the Read the clipboard permission.');
                }
                parsed.push({ type: 'read_clipboard' });
                break;
              case 'write_clipboard':
                if (!caps.clipboardWrite) {
                  return fail('TOOL_DISABLED: write_clipboard needs the Replace clipboard text permission.');
                }
                parsed.push({ type: 'write_clipboard', text: a.text });
                break;
            }
          }
          logInfo(`tool computer ${parsed.map((a) => a.type).join(', ')}`);
          noteDetail(parsed.map((a) => a.type).join(', '));
          const verifyCapture = verify?.capture === 'always' || verify?.capture === 'on_change';
          const mutatesDesktop = parsed.some((action) =>
            action.type !== 'wait' && action.type !== 'read_clipboard' && action.type !== 'write_clipboard' && action.type !== 'move'
          );
          const autoCapture = caps.screen && captureAfter !== false && mutatesDesktop;
          const wantsCapture = captureAfter === true || verifyCapture || autoCapture;
          if ((verify || wantsCapture) && !caps.screen) {
            return fail('TOOL_DISABLED: verification and result capture need the See the screen permission.');
          }
          const parsedVerify: VerificationSpec | undefined = verify
            ? verify.until === 'foreground'
              ? { until: 'foreground', window: verify.window!, timeoutMs: verify.timeout_ms }
              : verify.until === 'window_exists' || verify.until === 'window_closed'
                ? { until: verify.until, match: verify.match!, timeoutMs: verify.timeout_ms }
                : {
                    until: verify.until,
                    window: verify.window,
                    match: verify.match!,
                    role: verify.role,
                    timeoutMs: verify.timeout_ms
                  }
            : undefined;
          // One lock, one operation: the picture that verifies these actions must be taken
          // before anyone else can touch the desktop.
          const result = await actAndCapture(parsed, {
            frameId,
            targetWindow,
            verify: parsedVerify,
            capture:
              wantsCapture
                ? {
                    window: captureWindow ?? (captureFull === true || captureCrop !== undefined ? undefined : targetWindow),
                    full: captureFull,
                    maxWidth: captureMaxWidth ?? (autoCapture ? 1600 : undefined),
                    crop: captureCrop,
                    preferActiveWindow:
                      ctx.privacyScreenshots ||
                      (autoCapture && captureWindow === undefined && targetWindow === undefined && captureFull !== true && captureCrop === undefined)
                  }
                : undefined
          });
          const cursor = result.cursor;
          const pointer = cursor
            ? cursor.image
              ? `Pointer image: ${cursor.image.x},${cursor.image.y} (frame ${cursor.frameId}, ${cursor.imageSize?.width}x${cursor.imageSize?.height}); desktop: ${cursor.screen.x},${cursor.screen.y}.`
              : cursor.frameId === null
                ? `Pointer desktop: ${cursor.screen.x},${cursor.screen.y}. No screenshot frame is active.`
                : `Pointer desktop: ${cursor.screen.x},${cursor.screen.y}. It is outside frame ${cursor.frameId}, so it has no position in that image.`
            : 'Pointer position was not queried because this batch used only local wait/clipboard actions.';
          // Clipboard reads are the one action that returns something, so they are quoted
          // back in order rather than folded into the "Done:" line.
          const clipboardLines: string[] = [];
          let clipboardBudget = MAX_CLIPBOARD_OUTPUT_CHARS;
          for (const [index, text] of result.clipboard.entries()) {
            if (clipboardBudget <= 0) {
              clipboardLines.push(`… ${result.clipboard.length - index} more clipboard read(s) omitted by the output cap`);
              break;
            }
            const prefixText = `Clipboard read ${index + 1}: `;
            const rendered = text === '' ? '(empty)' : JSON.stringify(text);
            const payloadCap = Math.max(0, Math.min(MAX_CLIPBOARD_LINE_CHARS, clipboardBudget - prefixText.length - 80));
            const payload =
              rendered.length <= payloadCap
                ? rendered
                : `${rendered.slice(0, payloadCap)}… [truncated; ${text.length} chars original]`;
            const line = `${prefixText}${payload}`.slice(0, clipboardBudget);
            clipboardLines.push(line);
            clipboardBudget -= line.length + 1;
          }
          const clipboard = clipboardLines.join('\n');
          const routeSummary = [...new Set(result.routes)].join('+') || 'local';
          const verified = result.verification
            ? `\nVerified ${result.verification.until} in ${result.verification.elapsedMs} ms: ${result.verification.detail}.`
            : '';
          const captureFallback = result.captureFallback ? `\nCapture note: ${result.captureFallback}.` : '';
          const done = `Done ${result.completedCount}/${parsed.length} via ${routeSummary}: ${parsed.map((a) => a.type).join(', ')}. ${pointer}${clipboard ? `\n${clipboard}` : ''}${verified}${captureFallback}`;
          const shot = result.screenshot;
          if (shot) {
            return desktopImageResult(
              `${done}\nCaptured frame ${shot.frameId}, ${shot.width}x${shot.height}. Use this frame for the next coordinates.`,
              shot.data
            );
          }
          return ok(done);
        })
    );

    /**
     * Web-page control, carried out by the extension rather than the operating system.
     *
     * Everything here goes through the ChatGPT page that issued the call: the app parks one
     * action, that page collects it on its next activity poll, and the extension's service
     * worker performs it over the DevTools protocol. The worker is the only part that can hold
     * such a session, and a DevTools session is the only route to trusted input — events a
     * content script dispatches are `isTrusted: false` and real pages reject them.
     *
     * Refused for ChatGPT's own tabs before anything else, in the driver: the model asking for
     * this is sitting in one, and a driver able to attach there could drive its own
     * conversation.
     */
    if (exposedCaps.control) reg.register(
      'browser',
      {
        title: 'Control a web page',
        description:
          'Drive a web page. observe first: refs plus a screenshot whose pixels are the coordinates. ' +
          'Prefer refs — re-resolved before use, so a moved element is hit and a vanished one refuses. ' +
          'No attach step: navigate starts a run, taking the newest ordinary tab or opening ' +
          'one; ChatGPT tabs are never driven. Needs browser control on in the extension popup.',
        inputSchema: z.object({ actions: z.array(browserActionArg).min(1).max(20) }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
      },
      async (input) =>
        reg.guarded('control', 'browser', async () => {
          // The conversation is the address: the action is delivered to the page showing it,
          // which is the same evidence every identity-sensitive route in this app uses.
          const conversationId = currentCall()?.caller.conversationId ?? null;
          if (!conversationId) {
            return fail(
              'CALLER_IDENTITY_REQUIRED: browser control is delivered to the ChatGPT page that asked for it, ' +
                'and this call could not be attributed to a conversation. No browser action was taken.'
            );
          }

          // One block per action rather than one flat list, because an earlier observation has
          // to be removable at the end: the driver keeps only the newest observation's refs
          // addressable and replaces that map wholesale each time. Printing every observation's
          // refs hands back a list whose earlier half is already dead, with nothing marking
          // which half — a model would pick one, be refused, and have no reason why.
          const blocks: Array<{ observed: boolean; lines: string[] }> = [];
          let shot: { data: string; width: number; height: number } | null = null;
          for (const [index, action] of input.actions.entries()) {
            const reply = await runBrowserCommand(conversationId, action as Record<string, unknown>);
            if (!reply.ok) {
              // Stops at the first failure rather than pressing on: later actions were chosen
              // for a page state that this one did not produce.
              return fail(
                `${reply.error ?? 'BROWSER_FAILED'}: ${reply.detail ?? 'the browser action did not complete'}. ` +
                  `Completed ${index} of ${input.actions.length}.`
              );
            }
            const data = reply.data ?? {};
            if (action.type === 'observe') {
              const elements = Array.isArray(data['elements']) ? (data['elements'] as Array<Record<string, unknown>>) : [];
              blocks.push({ observed: true, lines: [
                `page: ${String(data['url'] ?? '')}`,
                `title: ${String(data['title'] ?? '')}`,
                ...elements.map(
                  (element) =>
                    `${String(element['ref'])} ${String(element['role'])} ${JSON.stringify(String(element['name'] ?? ''))}` +
                    `${element['disabled'] === true ? ' disabled' : ''} at ${String(element['x'])},${String(element['y'])}`
                )
              ] });
              const picture = data['screenshot'] as { data: string; width: number; height: number } | null | undefined;
              if (picture && typeof picture.data === 'string') shot = picture;
            } else if (action.type === 'detach' || action.type === 'status') {
              // These answer a question about the session rather than doing something to a page,
              // so "ok" is not an answer. Say which tab is held, or that none is.
              const attached = data['attached'] === true;
              const released = data['released'] as Record<string, unknown> | undefined;
              blocks.push({ observed: false, lines: [
                attached
                  ? `${action.type}: holding tab ${String(data['tabId'])} — ${String(data['title'] ?? '')} ` +
                    `(${String(data['url'] ?? '')})` +
                    // The group is the visible claim that this tab is being driven. Saying it here
                    // is what lets the caller check that claim instead of a person having to look
                    // at the tab strip.
                    (data['groupId'] === null || data['groupId'] === undefined
                      ? ', not in a driven group'
                      : `, in driven group ${String(data['groupId'])}`)
                  : released
                    ? `${action.type}: let go of tab ${String(released['tabId'])} — ` +
                      `${String(released['title'] ?? '')} (${String(released['url'] ?? '')}); ` +
                      'no tab is under control'
                    : `${action.type}: no tab is under control`
              ] });
            } else {
              blocks.push({ observed: false, lines: [`${action.type}: ok`] });
            }
          }

          const newestObservation = blocks.reduce(
            (latest, block, index) => (block.observed ? index : latest),
            -1
          );
          const body = blocks
            .flatMap((block, index) =>
              block.observed && index !== newestObservation
                ? ['observe: superseded by a later observation in this call; those refs are gone']
                : block.lines
            )
            .join('\n');
          if (shot) {
            return desktopImageResult(
              `${body}\nScreenshot ${shot.width}x${shot.height}; its pixels are the coordinates for this page.`,
              shot.data
            );
          }
          return ok(body);
        })
    );
  }
}

function prefix(note: string | null, body: string): string {
  return note ? `${note}\n\n${body}` : body;
}

function describeWindow(window: {
  id: number;
  process: string;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  state: string;
}): string {
  return (
    `window: ${window.id}\nprocess: ${window.process}\ntitle: ${window.title}\n` +
    `bounds: ${window.x},${window.y} ${window.width}x${window.height}\nstate: ${window.state}`
  );
}
