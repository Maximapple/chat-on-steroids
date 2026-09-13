# Final delta round — macOS, Claude Code

Run of `docs/qa-final-delta.md`. Installed build **2.0.5+1a26155** (confirmed in the app's own title
bar), which is the tip; `git diff 1a26155..HEAD -- src/ extension/ native/ scripts/ package.json` is
empty. The delta since the last tested build measures exactly the 217 insertions the brief names.

**No code changes were needed, so there are no fix hashes.**

## Baseline — green, no failures

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | clean |
| `npx vitest run` | 2340 passed / 98 skipped, 84 files passed / 3 skipped — **0 failed** |
| `npm run verify:privacy` | passed (366 commits, 4 tags) |
| `npm run verify:browser` | **74/74** |
| `npm run verify:compact-chain` | verified — 7 checkpoints plus the control |

---

## A line per item

**1. The merge conflict — PASS on real hardware, both halves. The merge is right.**

Captured window 11023 (TextEdit, desktop `214,112 656x422`) as frame 3, `1280x823`, scale 1.9512.

*Pointer outside the frame.* Moved the pointer to desktop `540,701` — below the window, whose
bottom edge is y=534 — via the full-desktop frame, then took the report against frame 3:

    Pointer desktop: 540,701. It is outside frame 3, so it has no position in that image.

`image` is null and `screen` is exact. That is your bounds check doing exactly what it was added
for; this is the case that once answered `875,754` for a 646-tall image.

*Pointer inside the frame.*

    Pointer image: 636,367 (frame 3, 1280x823); desktop: 540,300.

A real coordinate, and the arithmetic checks out against the frame's own region and scale.

*Independently verified.* I did not take the helper's word for `screen`. An OS-level
`screencapture -C` (nothing to do with the app) shows the I-beam drawn at capture `1078,600` =
desktop `539,300`, against a reported `540,300` — exact within rounding.

So: keeping both halves is correct, and your reasoning holds as stated. "Is this the right frame"
and "is the point inside it" really are different questions, and on this hardware the second one is
the one that fires — the frame was current, and only the bounds check stood between the caller and
an impossible coordinate. Had you taken upstream's line alone, this exact case would have regressed
to the `875,754` shape.

One honest limit on that answer: I confirmed the **bounds** half by driving it, and the
**generation** half by reading it. The generation gate is not externally inducible on macOS — the
helper is an in-process N-API addon (`macos-desktop-addon.node`), not a separate process, so there
is nothing to kill to bump `helperGeneration`. I could not manufacture a stale-generation frame from
outside, and I did not pretend to. Upstream's own test covers it and the merged form passes it.

**2a. Desktop reply provenance — PASS.** Covered by item 1; that is the same code.

**2b. Activity tool details — PASS.** Opened a chat with tool calls (`6a9bc7c8-…`). The tool rows
render with disclosure chevrons; clicking one expanded it and revealed the detail line
`exec_command · completed · 30157 ms`, with the chevron rotating to its open state. Native
`<details>`/`<summary>` semantics, working. Collapsed it again afterwards.

**2c. Folder access stays editable after setup — PASS.** On Home, the FOLDERS card and its **Add**
control are visible and enabled with the folder step already `is-done`. On Setup, with the wizard
rendered, both `wizAddFolder` and `wizManageFolders` are visible. I also exercised the specific rule
this fix added by applying `is-tidy` to the wizard: under it the folder step's prose collapses
(`folderInstructions: hidden`) while **both actions stay visible** — which is precisely what
`.wizard.is-tidy .step.is-done[data-step='folder'] .step-body > .step-actions { display: flex }` is
for. Class restored afterwards.

**3a. The truncated note — PASS, verified by arithmetic and both tests; not driven live.** The note
is now 196 characters and ends `…Check the screen, or use navigate to reach the address directly.`
The truncation it has to survive is `src/main/mcp/tools-desktop.ts:980` —
`text.length > 200 ? text.slice(0, 200) + '…' : text` — a per-field length comparison, so 196
survives whole with no ellipsis. `test/browser-answer.test.ts` drives the real `renderBrowserAction`
and asserts both halves (`toContain('use navigate to reach the address directly.')`,
`not.toContain('…')`); I ran it on its own: 11 passed.

I did **not** reproduce a live swallowed click. The `browser` tool is attribution-fenced
(`CALLER_IDENTITY_REQUIRED`), so it can only be driven from a ChatGPT turn, and a click that is
swallowed on demand needs a page that eats one. I am comfortable calling this confirmed anyway,
and I want to be explicit about why rather than hide the gap: the note is a static string literal,
the threshold is a constant, and 196 ≤ 200 is not a thing a live run can decide differently. The
seam the commit message warns about — the driver setting the field and the MCP layer rendering it —
is covered from both sides: `verify:browser` (74/74) includes the driver reporting a link click
that reached nothing, and the renderer test covers the rendering.

**3b. `INPUT_TARGET_REQUIRED` points at the browser tool, `STALE_FRAME` does not — PASS.**

My first attempt looked like a FAIL and was my error, worth recording so nobody repeats it. With
TextEdit frontmost the message came back bare:

    INPUT_TARGET_REQUIRED: physical pointer and application text mutations require targetWindow,
    a window-bound frame, a semantic ref, or focus(window) in the same batch.

That is correct. `browserInputHint()` appends only when the window the input was aimed at is
actually a browser, and mine was a text editor. With Chrome frontmost:

    INPUT_TARGET_REQUIRED: … in the same batch. The window is a browser ("Neuer Tab"), and desktop
    input cannot reach a web page that has no focused control yet — the click that would give it one
    is the click being refused. Use the browser tool for the page itself: it drives Chrome directly
    and needs no desktop focus.

And `STALE_FRAME` stays clean in both conditions, including with a browser frontmost:

    STALE_FRAME: frame 99 is no longer retained. Call observe again and point at the frameId from
    that reply's screenshot.

Which is the right split, for the reason the source comment gives: that one is an answer about the
screenshot, not about aiming input.

---

## Two things I met in passing, neither a defect

- `UIA_AMBIGUOUS_WINDOW` refused my first pointer test because two Finder windows sat at identical
  coordinates with identical titles (a DMG mounted twice). The refusal named both, said nothing was
  done, and said that focus would meet the same ambiguity so the fix is to move or close one. I
  moved to another window and continued. That is a fence answering a genuinely undecidable question
  well.
- Input coordinates are themselves frame-fenced: asking to `move` to a point outside the given frame
  earns `OUT_OF_FRAME` rather than moving there. Worth knowing for anyone repeating item 1 — you
  cannot reach the outside-the-frame case by asking for it directly; move via a wider frame and then
  take the report against the narrow one.

## Machine restoration

App restarted normally, no debug port. Home tab restored, the wizard class I toggled restored, the
tool disclosure I expanded collapsed again. No blocked chats, local tree clean. Chrome is left on the
`6a9bc7c8-…` chat rather than the new tab it started on.

---

## The release question

**Is there anything here I would not ship?** No. Every item in this round passed, the one that
mattered passed on hardware in both directions, and it passed in a way that actually vindicates the
judgement call rather than merely failing to contradict it: on this machine the frame was current,
so upstream's generation gate was never the thing standing between the caller and a bad coordinate —
your bounds check was. Keeping both was not belt-and-braces, it was the difference between correct
and regressed for the exact case QA found. I would propose this upstream as it stands.

The one thing I would not let pass silently is the shape of my own evidence, because it is the third
round running where the honest answer has the same asymmetry. I drove the bounds half and read the
generation half; I drove the disclosure and the folder rule and read the note's arithmetic. Every
one of those reads is sound and I would defend each individually. But "confirmed on hardware" and
"confirmed by reading the code plus its test" are different claims, and this branch has now
accumulated several of the second kind in places where the first kind was asked for. None of them is
wrong. It is just worth knowing, before this goes upstream, that the merged pointer report is the
only thing in today's delta that a human hand actually touched — and even there, half of it.
