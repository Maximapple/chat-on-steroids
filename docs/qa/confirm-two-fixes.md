# Two measurements that would close the last open questions

Both come from the same run that produced the drag ablation and the TCC series. Neither takes
long, and each settles something currently believed rather than known.

Paste everything below the line into Claude Code on the Mac. **No DMG and no installed app are
needed** — this drives the helper the repository builds, so it can be done while a package is
still building.

---

Two questions, both answered by measurement rather than by reading the source. Report what you
observe, including if it contradicts what the code says should happen.

Start by getting the repository and building the helper. Skip the clone line if the directory is
already there:

```sh
git clone https://github.com/Maximapple/chat-on-steroids.git ~/chat-on-steroids
cd ~/chat-on-steroids
git fetch origin
git checkout integrate/browser-and-desktop-064733
git pull --ff-only
npm ci
node scripts/prepare-macos-desktop-helper.mjs --platform darwin --arch arm64
```

That leaves the helper at
`resources/packaging/desktop/darwin/arm64/macos-desktop-helper`, which speaks newline-delimited
JSON on stdin and stdout. Both questions below drive it directly.

Screen Recording and Accessibility must be granted to whichever application owns the terminal —
macOS attaches the grant to the GUI ancestor, usually `Terminal.app`, not to `node`.

## 1. Is the frozen running-applications cache actually gone?

A previous run on this machine found that a helper goes permanently blind to applications started
after its first query: `NSWorkspace.shared.frontmostApplication` is served from a cache kept
current by run-loop notifications, and the helper never runs a loop. It was reproduced three
times out of three with two helpers side by side, and named as a mechanism — but never confirmed
by patching and re-running.

`318ee11` changed `frontmostPID()` to drain the run loop's ready sources before reading. Repeat
the original reproduction against the current code:

- start helper H1, ask it `{"op":"cursor"}` and `{"op":"windows"}` — this takes its snapshot
- launch TextEdit with a document and bring it to the front
- ask H1 the same two ops again
- start a fresh helper H2 and ask it the same two

Before the change: H1 answered `foreground=0` with no window claiming foreground, and kept
answering that, while H2 was correct. If H1 now names TextEdit, the fix holds. If it still does
not, the drain is not reaching the notification that matters and I need the exact output.

## 2. Does a drag work *through the app*, not only against the helper?

The ablation measured 6 of 6 moved — driving the helper directly, with Finder opened **before**
the helper, deliberately avoiding the cache defect above. The ChatGPT run drove the same drag
through model → MCP → app → helper and saw no movement at all.

That difference is the interesting part, and the cache defect is the obvious suspect: the app
runs one long-lived helper, so Finder opened afterwards would have been invisible to it, and an
input fence that cannot see the target refuses or misfires.

So drive a drag through the app this time:

- launch Chat On Steroids and let it settle, then open a Finder window with a file and a target
  folder — in that order, so the app's helper predates the window exactly as it did for the run
  that failed
- ask the desktop tooling to drag the file onto the folder
- check the filesystem, allowing 0-11ms for the move to become visible

If it moves now, the cache fix explains both symptoms and the drag finding is closed. If it does
not, that is the more interesting answer: something in the app layer differs from the helper it
wraps, and the next thing to compare is what `assertInputTarget` sees in each case.

## What to report

For each: what you did, what came back verbatim, and whether it agrees with the expectation
above. A contradiction is a better result than a confirmation — the last two rounds of this work
were corrected by measurements that disagreed with what I had reasoned.
