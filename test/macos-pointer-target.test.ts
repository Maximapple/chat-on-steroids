import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'darwin')('keeps pointer authorization independent of keyboard focus', () => {
  const source = readFileSync('native/macos-desktop-helper/main.swift', 'utf8');
  const functions = ['frontWindowID', 'inputTargetMatches', 'assertInputTarget', 'assertPointerTarget', 'click']
    .map((name) => {
      const extracted = source.match(new RegExp(`private func ${name}\\([\\s\\S]*?\\n\\}`))?.[0];
      expect(extracted, `missing Swift function: ${name}`).toBeTruthy();
      return extracted;
    }).join('\n');
  // Execute production predicates and click ordering. Only OS observations/event posting are
  // replaced; these tests never activate a window or send input to the developer's desktop.
  const program = `
import Foundation
import CoreGraphics
private struct WindowRow { let id: CGWindowID; let pid: pid_t; let onScreen = true }
private struct Failure: Error {}
private let target = WindowRow(id: 100, pid: 42)
private var top: CGWindowID? = 100
private var focused: CGWindowID? = 100
private var keyboard: CGWindowID? = 100
private var frontPID: pid_t? = 42
private var loseTopOnDown = false
private var events: [CGEventType] = []
private var rows: [WindowRow] { [target, WindowRow(id: 200, pid: 42)] }
private func fail(_ code: String, _ message: String) -> Failure { Failure() }
private func frontmostPID() -> pid_t? { frontPID }
private func allWindowRows(includeMinimized: Bool) -> [WindowRow] { rows }
private func windowServerFrontWindowID(rows: [WindowRow]? = nil) -> CGWindowID? { top }
private func focusedAXWindowID(for pid: pid_t, rows: [WindowRow]) -> CGWindowID? { focused }
private func focusedAXElementWindowID(for pid: pid_t, rows: [WindowRow]) -> CGWindowID? { keyboard }
private func windowRow(_ id: CGWindowID) -> WindowRow? { rows.first { $0.id == id } }
private func inputTargetRefusal(_ row: WindowRow) -> String { "test observation" }
private func requirePointOnActiveDisplay(_ point: CGPoint) throws {}
private func mouseTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
}
private func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64) throws {
    events.append(type)
    if loseTopOnDown && type == .leftMouseDown { top = 200 }
}
${functions}
var results: [[String: Any]] = []
for scenario in ["exact", "same-process-top", "unknown-top", "other-process", "unknown-focus", "unknown-control", "changed-after-down"] {
    top = scenario == "same-process-top" ? 200 : scenario == "unknown-top" ? nil : 100
    frontPID = scenario == "other-process" ? 99 : 42
    focused = scenario == "unknown-focus" ? nil : 100
    keyboard = scenario == "unknown-control" ? nil : 100
    loseTopOnDown = scenario == "changed-after-down"
    events = []
    let keyboardAccepted = inputTargetMatches(target)
    var accepted = false
    do {
        try click(CGPoint(x: 50, y: 50), button: .left, count: 1, targetWindow: 100)
        accepted = true
    } catch {}
    results.append(["scenario": scenario, "keyboard": keyboardAccepted, "accepted": accepted,
                    "events": events.map { $0.rawValue }])
}
print(String(data: try JSONSerialization.data(withJSONObject: results), encoding: .utf8)!)
`;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cos-pointer-test-'));
  try {
    const file = path.join(dir, 'probe.swift');
    writeFileSync(file, program);
    const results = JSON.parse(execFileSync('/usr/bin/swift', [file], { encoding: 'utf8', timeout: 25_000 }));
    expect(results).toEqual([
      { scenario: 'exact', keyboard: true, accepted: true, events: [1, 2] },
      { scenario: 'same-process-top', keyboard: true, accepted: false, events: [] },
      { scenario: 'unknown-top', keyboard: false, accepted: false, events: [] },
      { scenario: 'other-process', keyboard: false, accepted: false, events: [] },
      { scenario: 'unknown-focus', keyboard: false, accepted: false, events: [] },
      { scenario: 'unknown-control', keyboard: false, accepted: false, events: [] },
      // Releasing a held button after target loss is cleanup, not a successful click.
      { scenario: 'changed-after-down', keyboard: true, accepted: false, events: [1, 2] }
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
