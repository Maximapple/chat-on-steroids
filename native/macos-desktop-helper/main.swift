import Foundation
import AppKit
import ApplicationServices
import ScreenCaptureKit
import CoreMedia
import CoreImage
import ImageIO
import UniformTypeIdentifiers

private typealias JSONObject = [String: Any]

// Native Desktop safety budgets. Window matching deliberately fails closed: a semantic
// AX element or pixel frame is never allowed to drift onto a different native window.
private let AX_WINDOW_GEOMETRY_TOLERANCE: CGFloat = 24
private let FOCUS_POLL_TIMEOUT_SECONDS: TimeInterval = 2.5
private let POINTER_ANIMATION_MAX_STEPS = 12
private let MAX_CAPTURE_PIXELS = 8_000_000

private struct HelperFailure: Error {
    let code: String
    let message: String
}

private func fail(_ code: String, _ message: String) -> HelperFailure {
    HelperFailure(code: code, message: message)
}

private func number(_ value: Any?) -> NSNumber? {
    value as? NSNumber
}

private func int(_ value: Any?, default fallback: Int = 0) -> Int {
    number(value)?.intValue ?? fallback
}

private func bool(_ value: Any?, default fallback: Bool = false) -> Bool {
    number(value)?.boolValue ?? fallback
}

private func string(_ value: Any?, default fallback: String = "") -> String {
    value as? String ?? fallback
}

private func rectObject(_ rect: CGRect) -> JSONObject {
    [
        "x": Int(rect.origin.x.rounded()),
        "y": Int(rect.origin.y.rounded()),
        "width": Int(rect.width.rounded()),
        "height": Int(rect.height.rounded())
    ]
}

private func rect(_ value: Any?) -> CGRect? {
    guard let object = value as? JSONObject else { return nil }
    let x = number(object["x"])?.doubleValue
    let y = number(object["y"])?.doubleValue
    let width = number(object["width"])?.doubleValue
    let height = number(object["height"])?.doubleValue
    guard let x, let y, let width, let height, width > 0, height > 0 else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

private func virtualScreenRect() throws -> CGRect {
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else {
        throw fail("SCREEN_UNAVAILABLE", "no active display is available")
    }
    var displays = Array(repeating: CGDirectDisplayID(), count: Int(count))
    guard CGGetActiveDisplayList(count, &displays, &count) == .success else {
        throw fail("SCREEN_UNAVAILABLE", "the active display list could not be read")
    }
    return displays.prefix(Int(count)).map(CGDisplayBounds).reduce(CGRect.null) { $0.union($1) }
}

private struct WindowRow {
    let id: CGWindowID
    let pid: pid_t
    let title: String
    let process: String
    let bounds: CGRect
    let onScreen: Bool
    let layer: Int

    func json(foreground: CGWindowID?) -> JSONObject {
        [
            "id": Int(id),
            "title": title,
            "process": process,
            "x": Int(bounds.origin.x.rounded()),
            "y": Int(bounds.origin.y.rounded()),
            "width": Int(bounds.width.rounded()),
            "height": Int(bounds.height.rounded()),
            "state": id == foreground ? "foreground" : (onScreen ? "open" : "minimized")
        ]
    }
}

private func allWindowRows() -> [WindowRow] {
    guard let raw = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID)
        as? [JSONObject] else { return [] }
    let ownPid = getpid()
    return raw.compactMap { item in
        guard
            let id = number(item[kCGWindowNumber as String])?.uint32Value,
            let pid = number(item[kCGWindowOwnerPID as String])?.int32Value,
            pid != ownPid,
            let boundsDictionary = item[kCGWindowBounds as String] as? NSDictionary,
            let bounds = CGRect(dictionaryRepresentation: boundsDictionary),
            bounds.width > 1,
            bounds.height > 1
        else { return nil }
        let layer = int(item[kCGWindowLayer as String])
        let onScreen = bool(item[kCGWindowIsOnscreen as String])
        let alpha = number(item[kCGWindowAlpha as String])?.doubleValue ?? 1
        guard layer == 0, alpha > 0 else { return nil }
        let process = string(item[kCGWindowOwnerName as String], default: "Process \(pid)")
        let title = string(item[kCGWindowName as String]).trimmingCharacters(in: .whitespacesAndNewlines)
        let displayTitle = title.isEmpty ? "\(process) window" : title
        return WindowRow(
            id: id,
            pid: pid,
            title: displayTitle,
            process: process,
            bounds: bounds,
            onScreen: onScreen,
            layer: layer
        )
    }
}

private func windowRow(_ id: CGWindowID) -> WindowRow? {
    allWindowRows().first { $0.id == id }
}

private func frontmostPID() -> pid_t? {
    NSWorkspace.shared.frontmostApplication?.processIdentifier
}

private func focusedAXWindowID(for pid: pid_t, rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    guard AXIsProcessTrusted() else { return nil }
    let app = AXUIElementCreateApplication(pid)
    guard let focused = axElementAttribute(app, kAXFocusedWindowAttribute as CFString) else { return nil }
    if let exact = axWindowNumber(focused) { return exact }
    guard let bounds = axBounds(focused) else { return nil }
    let rows = suppliedRows ?? allWindowRows()
    return rows
        .filter { $0.pid == pid && geometryConvincinglyMatches(bounds, $0.bounds) }
        .min(by: { geometryDistance(bounds, $0.bounds) < geometryDistance(bounds, $1.bounds) })?.id
}

private func windowServerFrontWindowID(rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    let rows = suppliedRows ?? allWindowRows()
    return rows.first(where: { $0.onScreen })?.id
}

private func foregroundWindowID() -> CGWindowID? {
    guard let pid = frontmostPID() else { return nil }
    let rows = allWindowRows()
    // Workspace and WindowServer can briefly disagree during an app switch. Returning no
    // foreground window is safer than attributing input to stale state from either side.
    guard let windowServerFrontID = windowServerFrontWindowID(rows: rows),
          let windowServerFront = rows.first(where: { $0.id == windowServerFrontID }),
          windowServerFront.pid == pid else { return nil }
    if let focused = focusedAXWindowID(for: pid, rows: rows),
       rows.contains(where: { $0.id == focused && $0.pid == pid && $0.onScreen }) {
        return focused
    }
    return windowServerFront.id
}

private func requireAccessibility(prompt: Bool) throws {
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: prompt] as CFDictionary
    guard AXIsProcessTrustedWithOptions(options) else {
        throw fail(
            "ACCESSIBILITY_PERMISSION_REQUIRED",
            "enable Accessibility for Chat On Steroids in System Settings > Privacy & Security > Accessibility, then retry"
        )
    }
}

private func requireScreenCapture() throws {
    guard CGPreflightScreenCaptureAccess() else {
        _ = CGRequestScreenCaptureAccess()
        throw fail(
            "SCREEN_PERMISSION_REQUIRED",
            "enable Screen Recording for Chat On Steroids in System Settings > Privacy & Security > Screen & System Audio Recording, then retry"
        )
    }
}

private func axAttribute(_ element: AXUIElement, _ attribute: CFString) -> AnyObject? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
    return value
}

private func axElementAttribute(_ element: AXUIElement, _ attribute: CFString) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success, let value else { return nil }
    guard CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return value as! AXUIElement
}

private func axString(_ element: AXUIElement, _ attribute: CFString) -> String? {
    axAttribute(element, attribute) as? String
}

private func axBool(_ element: AXUIElement, _ attribute: CFString, default fallback: Bool) -> Bool {
    (axAttribute(element, attribute) as? NSNumber)?.boolValue ?? fallback
}

private func axPoint(_ element: AXUIElement, _ attribute: CFString) -> CGPoint? {
    guard let value = axAttribute(element, attribute) else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgPoint else { return nil }
    var point = CGPoint.zero
    return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

private func axSize(_ element: AXUIElement, _ attribute: CFString) -> CGSize? {
    guard let value = axAttribute(element, attribute) else { return nil }
    let axValue = value as! AXValue
    guard AXValueGetType(axValue) == .cgSize else { return nil }
    var size = CGSize.zero
    return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

private func axBounds(_ element: AXUIElement) -> CGRect? {
    guard let point = axPoint(element, kAXPositionAttribute as CFString),
          let size = axSize(element, kAXSizeAttribute as CFString),
          size.width >= 0,
          size.height >= 0 else { return nil }
    return CGRect(origin: point, size: size)
}

private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    axAttribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] ?? []
}

private func axRole(_ element: AXUIElement) -> String {
    let raw = axString(element, kAXRoleAttribute as CFString) ?? "AXUnknown"
    return raw.hasPrefix("AX") ? String(raw.dropFirst(2)) : raw
}

private func axName(_ element: AXUIElement) -> String {
    for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute] {
        if let value = axString(element, attribute as CFString)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !value.isEmpty { return value }
    }
    return ""
}

private func axWindowNumber(_ element: AXUIElement) -> CGWindowID? {
    (axAttribute(element, "AXWindowNumber" as CFString) as? NSNumber)?.uint32Value
}

private func geometryDistance(_ candidate: CGRect, _ expected: CGRect) -> CGFloat {
    abs(candidate.minX - expected.minX) + abs(candidate.minY - expected.minY) +
        abs(candidate.width - expected.width) + abs(candidate.height - expected.height)
}

private func geometryConvincinglyMatches(_ candidate: CGRect, _ expected: CGRect) -> Bool {
    guard !candidate.isNull, !candidate.isEmpty else { return false }
    return abs(candidate.minX - expected.minX) <= AX_WINDOW_GEOMETRY_TOLERANCE &&
        abs(candidate.minY - expected.minY) <= AX_WINDOW_GEOMETRY_TOLERANCE &&
        abs(candidate.width - expected.width) <= AX_WINDOW_GEOMETRY_TOLERANCE &&
        abs(candidate.height - expected.height) <= AX_WINDOW_GEOMETRY_TOLERANCE
}

private func matchingAXWindow(_ row: WindowRow) throws -> AXUIElement {
    try requireAccessibility(prompt: true)
    let app = AXUIElementCreateApplication(row.pid)
    let windows = axAttribute(app, kAXWindowsAttribute as CFString) as? [AXUIElement] ?? []
    if let exact = windows.first(where: { axWindowNumber($0) == row.id }) { return exact }

    // AXWindowNumber is not available for every app. Geometry is an acceptable fallback only
    // when it is genuinely close to the requested CGWindow; never choose an arbitrary window
    // from the same process merely because it is the least-wrong candidate.
    let candidates = windows.compactMap { window -> (AXUIElement, CGRect)? in
        guard let bounds = axBounds(window), geometryConvincinglyMatches(bounds, row.bounds) else { return nil }
        return (window, bounds)
    }
    guard let best = candidates.min(by: { geometryDistance($0.1, row.bounds) < geometryDistance($1.1, row.bounds) }) else {
        throw fail("UIA_FAILED", "no accessible window convincingly matches window \(row.id)")
    }
    return best.0
}

private func setAXValueIfPossible(_ element: AXUIElement, _ attribute: CFString, _ value: CFTypeRef) {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, attribute, &settable) == .success,
          settable.boolValue else { return }
    _ = AXUIElementSetAttributeValue(element, attribute, value)
}

private func setAXBooleanIfPossible(_ element: AXUIElement, _ attribute: CFString, _ value: Bool) {
    var settable = DarwinBoolean(false)
    guard AXUIElementIsAttributeSettable(element, attribute, &settable) == .success,
          settable.boolValue else { return }
    _ = AXUIElementSetAttributeValue(element, attribute, value ? kCFBooleanTrue : kCFBooleanFalse)
}

private func focusedAXElementWindowID(for pid: pid_t, rows suppliedRows: [WindowRow]? = nil) -> CGWindowID? {
    guard AXIsProcessTrusted() else { return nil }
    let app = AXUIElementCreateApplication(pid)
    guard let element = axElementAttribute(app, kAXFocusedUIElementAttribute as CFString) else { return nil }
    var current: AXUIElement? = element
    for _ in 0..<10 {
        guard let candidate = current else { return nil }
        if let window = axElementAttribute(candidate, kAXWindowAttribute as CFString) {
            if let exact = axWindowNumber(window) { return exact }
            if let bounds = axBounds(window) {
                let rows = suppliedRows ?? allWindowRows()
                return rows
                    .filter { $0.pid == pid && geometryConvincinglyMatches(bounds, $0.bounds) }
                    .min(by: { geometryDistance(bounds, $0.bounds) < geometryDistance(bounds, $1.bounds) })?.id
            }
        }
        if axRole(candidate) == "Window" {
            if let exact = axWindowNumber(candidate) { return exact }
            if let bounds = axBounds(candidate) {
                let rows = suppliedRows ?? allWindowRows()
                return rows
                    .filter { $0.pid == pid && geometryConvincinglyMatches(bounds, $0.bounds) }
                    .min(by: { geometryDistance(bounds, $0.bounds) < geometryDistance(bounds, $1.bounds) })?.id
            }
        }
        current = axElementAttribute(candidate, kAXParentAttribute as CFString)
    }
    return nil
}

private func inputTargetMatches(_ row: WindowRow) -> Bool {
    guard frontmostPID() == row.pid else { return false }
    guard let focused = focusedAXWindowID(for: row.pid), focused == row.id else { return false }
    guard foregroundWindowID() == row.id else { return false }
    if let focusedElementWindow = focusedAXElementWindowID(for: row.pid) {
        guard focusedElementWindow == row.id else { return false }
    }
    return true
}

private func focusWindow(_ id: CGWindowID) throws -> Bool {
    guard let row = windowRow(id) else { return false }
    try requireAccessibility(prompt: true)
    if inputTargetMatches(row) { return true }
    guard let app = NSRunningApplication(processIdentifier: row.pid) else { return false }
    let window = try matchingAXWindow(row)

    // Restore a minimized target before activation.
    var minimizedSettable = DarwinBoolean(false)
    if AXUIElementIsAttributeSettable(window, kAXMinimizedAttribute as CFString, &minimizedSettable) == .success,
       minimizedSettable.boolValue {
        _ = AXUIElementSetAttributeValue(window, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }

    _ = app.activate(options: [.activateIgnoringOtherApps])
    let appElement = AXUIElementCreateApplication(row.pid)
    setAXBooleanIfPossible(appElement, kAXFrontmostAttribute as CFString, true)
    setAXValueIfPossible(appElement, kAXMainWindowAttribute as CFString, window)
    setAXValueIfPossible(appElement, kAXFocusedWindowAttribute as CFString, window)
    setAXBooleanIfPossible(window, kAXMainAttribute as CFString, true)
    setAXBooleanIfPossible(window, kAXFocusedAttribute as CFString, true)
    _ = AXUIElementPerformAction(window, kAXRaiseAction as CFString)

    let deadline = Date().addingTimeInterval(FOCUS_POLL_TIMEOUT_SECONDS)
    repeat {
        if inputTargetMatches(row) { return true }
        usleep(25_000)
    } while Date() < deadline
    return false
}

// Passive assertion used immediately before physical input. It never steals focus: if the
// user or another app took focus, fail closed before posting an event to the wrong process.
private func assertInputTarget(_ id: CGWindowID) throws -> WindowRow {
    guard let row = windowRow(id) else {
        throw fail("WINDOW_NOT_FOUND", "target window \(id) no longer exists; no input was sent")
    }
    guard let livePID = frontmostPID(), livePID == row.pid else {
        let actual = frontmostPID().map { String($0) } ?? "none"
        throw fail(
            "INPUT_TARGET_LOST",
            "expected \(row.process) pid \(row.pid), but frontmost pid is \(actual); no input was sent"
        )
    }
    guard let focused = focusedAXWindowID(for: row.pid) else {
        throw fail(
            "AX_FOCUS_FAILED",
            "Accessibility did not expose a focused window for \(row.process); no input was sent"
        )
    }
    if focused != id {
        throw fail(
            "AX_FOCUS_FAILED",
            "expected focused window \(id), but Accessibility reports window \(focused); no input was sent"
        )
    }
    if let focusedElementWindow = focusedAXElementWindowID(for: row.pid), focusedElementWindow != id {
        throw fail(
            "AX_FOCUS_FAILED",
            "focused UI element belongs to window \(focusedElementWindow), expected \(id); no input was sent"
        )
    }
    guard foregroundWindowID() == id else {
        throw fail(
            "WINDOW_NOT_KEY_WINDOW",
            "window \(id) is not the active input window; no input was sent"
        )
    }
    return row
}

// Active acquisition is reserved for an explicit focus action, a window-bound coordinate
// frame, or a semantic click whose target is already known. Plain type/keypress never call it.
private func activateInputTarget(_ id: CGWindowID) throws {
    guard let row = windowRow(id) else {
        throw fail("WINDOW_NOT_FOUND", "target window \(id) no longer exists")
    }
    if inputTargetMatches(row) { return }
    if try focusWindow(id) {
        _ = try assertInputTarget(id)
        return
    }
    if frontmostPID() != row.pid {
        let actual = frontmostPID().map { String($0) } ?? "none"
        throw fail(
            "TARGET_APP_NOT_FRONTMOST",
            "could not activate \(row.process) pid \(row.pid); frontmost pid is \(actual)"
        )
    }
    guard let focused = focusedAXWindowID(for: row.pid) else {
        throw fail("AX_FOCUS_FAILED", "Accessibility did not expose a focused window for \(row.process)")
    }
    if focused != id {
        throw fail("AX_FOCUS_FAILED", "Accessibility focused window \(focused), expected \(id)")
    }
    throw fail("WINDOW_NOT_KEY_WINDOW", "window \(id) could not be proven as the active input target")
}

private final class UISnapshot {
    let window: CGWindowID
    let windowBounds: CGRect
    let elements: [String: AXUIElement]

    init(window: CGWindowID, windowBounds: CGRect, elements: [String: AXUIElement]) {
        self.window = window
        self.windowBounds = windowBounds
        self.elements = elements
    }
}

private var nextSnapshotID = 1
private var snapshots: [Int: UISnapshot] = [:]
private var snapshotOrder: [Int] = []

private func rememberSnapshot(window: CGWindowID, windowBounds: CGRect, elements: [String: AXUIElement]) -> Int {
    let id = nextSnapshotID
    nextSnapshotID += 1
    snapshots[id] = UISnapshot(window: window, windowBounds: windowBounds, elements: elements)
    snapshotOrder.append(id)
    while snapshotOrder.count > 16 {
        let removed = snapshotOrder.removeFirst()
        snapshots.removeValue(forKey: removed)
    }
    return id
}

private func findUI(_ request: JSONObject, suppliedWindow: WindowRow? = nil) throws -> JSONObject {
    let row: WindowRow
    if let suppliedWindow {
        row = suppliedWindow
    } else if let requested = number(request["id"])?.uint32Value, let found = windowRow(requested) {
        row = found
    } else if let foreground = foregroundWindowID(), let found = windowRow(foreground) {
        row = found
    } else {
        throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")
    }
    let root = try matchingAXWindow(row)
    let query = string(request["query"]).lowercased()
    let roleFilter = string(request["role"]).lowercased()
    let maxResults = min(100, max(1, int(request["maxResults"], default: 30)))
    let maxVisited = min(10_000, max(maxResults, int(request["maxVisited"], default: 4_000)))
    let screen = try virtualScreenRect()

    var queue: [AXUIElement] = [root]
    var cursor = 0
    var visited = 0
    var returned: [JSONObject] = []
    var retained: [String: AXUIElement] = [:]

    while cursor < queue.count && visited < maxVisited && returned.count < maxResults {
        let element = queue[cursor]
        cursor += 1
        visited += 1
        queue.append(contentsOf: axChildren(element))

        let role = axRole(element)
        let name = axName(element)
        let identifier = axString(element, kAXIdentifierAttribute as CFString) ?? ""
        let haystack = "\(name) \(role) \(identifier)".lowercased()
        guard (query.isEmpty || haystack.contains(query)),
              (roleFilter.isEmpty || role.lowercased().contains(roleFilter)) else { continue }
        guard let bounds = axBounds(element), bounds.width >= 0, bounds.height >= 0 else { continue }
        if query.isEmpty {
            let usefulRoles: Set<String> = [
                "Button", "CheckBox", "RadioButton", "PopUpButton", "ComboBox", "TextField",
                "TextArea", "Link", "MenuItem", "TabGroup", "Slider", "Incrementor",
                "DisclosureTriangle", "Document", "WebArea", "Outline", "Row", "Cell", "StaticText"
            ]
            if !usefulRoles.contains(role) && name.isEmpty && identifier.isEmpty { continue }
        }
        let runtimeKey = "e\(visited)"
        retained[runtimeKey] = element
        returned.append([
            "runtimeKey": runtimeKey,
            "name": name,
            "role": role,
            "automationId": identifier,
            "enabled": axBool(element, kAXEnabledAttribute as CFString, default: true),
            "offscreen": bounds.isEmpty || !screen.intersects(bounds),
            "bounds": rectObject(bounds)
        ])
    }

    let snapshotID = rememberSnapshot(window: row.id, windowBounds: row.bounds, elements: retained)
    return [
        "window": Int(row.id),
        "snapshotId": snapshotID,
        "elements": returned,
        "visited": visited,
        "truncated": cursor < queue.count || visited >= maxVisited
    ]
}

private func mouseButton(_ name: String) -> CGMouseButton {
    switch name.lowercased() {
    case "right": return .right
    case "middle", "wheel": return .center
    default: return .left
    }
}

private func mouseTypes(_ button: CGMouseButton) -> (CGEventType, CGEventType, CGEventType) {
    switch button {
    case .right: return (.rightMouseDown, .rightMouseUp, .rightMouseDragged)
    case .center: return (.otherMouseDown, .otherMouseUp, .otherMouseDragged)
    default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged)
    }
}

private func postMouse(_ type: CGEventType, point: CGPoint, button: CGMouseButton, clickState: Int64 = 1) throws {
    guard let event = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: point, mouseButton: button) else {
        throw fail("INPUT_FAILED", "could not create a mouse event")
    }
    event.setIntegerValueField(.mouseEventClickState, value: clickState)
    event.post(tap: .cghidEventTap)
}

private func movePointer(_ point: CGPoint) throws {
    try postMouse(.mouseMoved, point: point, button: .left)
}

private func movePointerSmoothly(to point: CGPoint) throws {
    let start = CGEvent(source: nil)?.location ?? point
    let distance = hypot(point.x - start.x, point.y - start.y)
    let steps = min(POINTER_ANIMATION_MAX_STEPS, max(1, Int((distance / 90).rounded(.up))))
    if steps <= 1 {
        try movePointer(point)
        return
    }
    for step in 1...steps {
        let progress = CGFloat(step) / CGFloat(steps)
        let eased = progress * progress * (3 - 2 * progress)
        let next = CGPoint(
            x: start.x + (point.x - start.x) * eased,
            y: start.y + (point.y - start.y) * eased
        )
        try movePointer(next)
        usleep(8_000)
    }
}

private func click(_ point: CGPoint, button: CGMouseButton, count: Int, targetWindow: CGWindowID? = nil) throws {
    try movePointerSmoothly(to: point)
    let (down, up, _) = mouseTypes(button)
    for clickIndex in 1...count {
        if let targetWindow { _ = try assertInputTarget(targetWindow) }
        try postMouse(down, point: point, button: button, clickState: Int64(clickIndex))
        try postMouse(up, point: point, button: button, clickState: Int64(clickIndex))
        usleep(35_000)
    }
}

private func drag(_ xs: [NSNumber], _ ys: [NSNumber], button: CGMouseButton, targetWindow: CGWindowID? = nil) throws {
    guard xs.count == ys.count, xs.count >= 2 else { throw fail("BAD_ACTION", "drag needs at least two points") }
    let points = zip(xs, ys).map { CGPoint(x: $0.0.doubleValue, y: $0.1.doubleValue) }
    let (down, up, dragged) = mouseTypes(button)
    try movePointerSmoothly(to: points[0])
    if let targetWindow { _ = try assertInputTarget(targetWindow) }
    try postMouse(down, point: points[0], button: button)
    var current = points[0]
    do {
        for point in points.dropFirst() {
            if let targetWindow { _ = try assertInputTarget(targetWindow) }
            try postMouse(dragged, point: point, button: button)
            current = point
            usleep(12_000)
        }
        if let targetWindow { _ = try assertInputTarget(targetWindow) }
        try postMouse(up, point: points[points.count - 1], button: button)
    } catch {
        try? postMouse(up, point: current, button: button)
        throw error
    }
}

private let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
    "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
    "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
    ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
    "backspace": 51, "delete": 51, "escape": 53, "esc": 53,
    "command": 55, "cmd": 55, "meta": 55, "shift": 56, "capslock": 57, "option": 58, "alt": 58,
    "control": 59, "ctrl": 59, "rightshift": 60, "rightoption": 61, "rightcontrol": 62,
    "f17": 64, "volumeup": 72, "volumedown": 73, "mute": 74, "f18": 79, "f19": 80,
    "f20": 90, "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101,
    "f11": 103, "f13": 105, "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
    "help": 114, "home": 115, "pageup": 116, "forwarddelete": 117, "f4": 118, "end": 119,
    "f2": 120, "pagedown": 121, "f1": 122, "left": 123, "right": 124, "down": 125, "up": 126
]

private let modifierFlags: [String: CGEventFlags] = [
    "command": .maskCommand,
    "shift": .maskShift,
    "rightshift": .maskShift,
    "option": .maskAlternate,
    "rightoption": .maskAlternate,
    "control": .maskControl,
    "rightcontrol": .maskControl,
    "capslock": .maskAlphaShift
]

private func normalizedKeyName(_ name: String) -> String {
    switch name.lowercased() {
    case "cmd", "meta": return "command"
    case "alt": return "option"
    case "ctrl": return "control"
    case "esc": return "escape"
    default: return name.lowercased()
    }
}

private func pressKeys(_ names: [String], targetWindow: CGWindowID) throws {
    var target = try assertInputTarget(targetWindow)
    let normalized = names.map(normalizedKeyName)
    guard let source = CGEventSource(stateID: .privateState) else {
        throw fail("INPUT_FAILED", "could not create a keyboard event source")
    }
    let codes = try normalized.map { name -> CGKeyCode in
        guard let code = keyCodes[name] else { throw fail("BAD_KEY", "unknown key \(name)") }
        return code
    }

    var flags: CGEventFlags = []
    var modifierIndices: [Int] = []
    var ordinaryIndices: [Int] = []
    for (index, name) in normalized.enumerated() {
        if modifierFlags[name] != nil { modifierIndices.append(index) } else { ordinaryIndices.append(index) }
    }

    func postKey(_ code: CGKeyCode, keyDown: Bool, flags: CGEventFlags) throws {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: keyDown) else {
            throw fail("INPUT_FAILED", "could not create a keyboard event")
        }
        event.flags = flags
        event.postToPid(target.pid)
    }

    // Re-check immediately before the chord. Ordinary key events carry the accumulated flags,
    // so Command+B is delivered as Command+B rather than relying on inferred global key state.
    target = try assertInputTarget(targetWindow)
    for index in modifierIndices {
        let name = normalized[index]
        guard let flag = modifierFlags[name] else { continue }
        flags.insert(flag)
        try postKey(codes[index], keyDown: true, flags: flags)
    }
    for index in ordinaryIndices {
        try postKey(codes[index], keyDown: true, flags: flags)
    }
    for index in ordinaryIndices.reversed() {
        try postKey(codes[index], keyDown: false, flags: flags)
    }
    for index in modifierIndices.reversed() {
        let name = normalized[index]
        guard let flag = modifierFlags[name] else { continue }
        flags.remove(flag)
        try postKey(codes[index], keyDown: false, flags: flags)
    }
}

private func typeText(_ text: String, targetWindow: CGWindowID) throws {
    guard let source = CGEventSource(stateID: .privateState) else {
        throw fail("INPUT_FAILED", "could not create a keyboard event source")
    }
    let units = Array(text.utf16)
    var cursor = 0
    while cursor < units.count {
        var target = try assertInputTarget(targetWindow)
        var end = min(units.count, cursor + 32)
        if end < units.count, end > cursor {
            let previous = units[end - 1]
            let next = units[end]
            if previous >= 0xD800 && previous <= 0xDBFF && next >= 0xDC00 && next <= 0xDFFF {
                end -= 1
            }
        }
        let chunk = Array(units[cursor..<end])
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
            throw fail("INPUT_FAILED", "could not create a text input event")
        }
        down.flags = []
        up.flags = []
        chunk.withUnsafeBufferPointer { pointer in
            down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
            up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: pointer.baseAddress!)
        }
        // No refocus here. A stolen focus means abort, never continue into the wrong app.
        target = try assertInputTarget(targetWindow)
        down.postToPid(target.pid)
        up.postToPid(target.pid)
        cursor = end
    }
}

private func cursorObject() -> JSONObject {
    let location = CGEvent(source: nil)?.location ?? .zero
    return ["x": Int(location.x.rounded()), "y": Int(location.y.rounded())]
}

private func actUI(_ request: JSONObject) throws -> JSONObject {
    try requireAccessibility(prompt: true)
    let snapshotID = int(request["snapshotId"])
    let runtimeKey = string(request["runtimeKey"])
    guard let snapshot = snapshots[snapshotID], snapshot.window == number(request["id"])?.uint32Value else {
        throw fail("STALE_UI_SNAPSHOT", "the UI snapshot is no longer available")
    }
    guard let element = snapshot.elements[runtimeKey] else {
        throw fail("UNKNOWN_UI_REF", "the UI element no longer exists in snapshot \(snapshotID)")
    }
    let action = string(request["action"])
    var route = "uia"
    if action == "set_value" {
        var settable = DarwinBoolean(false)
        guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
              settable.boolValue,
              AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, string(request["value"]) as CFTypeRef) == .success else {
            throw fail("UI_ACTION_FAILED", "the control does not expose a settable value")
        }
    } else if action == "click" {
        _ = try assertInputTarget(snapshot.window)
        if let bounds = axBounds(element), !bounds.isEmpty {
            try movePointerSmoothly(to: CGPoint(x: bounds.midX, y: bounds.midY))
        }
        _ = try assertInputTarget(snapshot.window)
        if AXUIElementPerformAction(element, kAXPressAction as CFString) != .success {
            // A physical fallback is only safe when the exact snapshot window is in front and
            // has not moved/resized. Otherwise the same screen coordinates may belong to an
            // unrelated window even though the retained AX element still exists.
            guard try focusWindow(snapshot.window) else {
                throw fail("FOCUS_FAILED", "window \(snapshot.window) could not be activated for click_ref")
            }
            guard let live = windowRow(snapshot.window), live.bounds.integral == snapshot.windowBounds.integral else {
                throw fail("STALE_UI_SNAPSHOT", "the UI snapshot window moved or resized")
            }
            guard let bounds = axBounds(element), !bounds.isEmpty else {
                throw fail("UI_ACTION_FAILED", "the control exposes neither AXPress nor usable bounds")
            }
            try click(CGPoint(x: bounds.midX, y: bounds.midY), button: .left, count: 1, targetWindow: snapshot.window)
            route = "sendinput"
        }
    } else {
        throw fail("BAD_ACTION", "unknown UI action \(action)")
    }
    return ["runtimeKey": runtimeKey, "name": axName(element), "route": route]
}

private func owningAXWindow(_ element: AXUIElement) -> AXUIElement? {
    var current: AXUIElement? = element
    for _ in 0..<8 {
        guard let candidate = current else { return nil }
        if axRole(candidate) == "Window" { return candidate }
        if let window = axElementAttribute(candidate, kAXWindowAttribute as CFString) { return window }
        current = axElementAttribute(candidate, kAXParentAttribute as CFString)
    }
    return nil
}

private func axWindowMatches(_ element: AXUIElement, _ row: WindowRow) -> Bool {
    guard let window = owningAXWindow(element) else { return false }
    if let number = axWindowNumber(window) { return number == row.id }
    guard let bounds = axBounds(window) else { return false }
    return geometryConvincinglyMatches(bounds, row.bounds)
}

private let safeHitTestPressRoles: Set<String> = [
    "Button", "CheckBox", "RadioButton", "PopUpButton", "MenuButton", "MenuItem",
    "Link", "DisclosureTriangle", "Tab"
]

private func tryPressElement(at point: CGPoint, target row: WindowRow) throws -> Bool {
    guard AXIsProcessTrusted() else { return false }
    let system = AXUIElementCreateSystemWide()
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(point.x), Float(point.y), &hit) == .success,
          let hit else { return false }
    guard axWindowMatches(hit, row) else { return false }

    var current: AXUIElement? = hit
    for _ in 0..<6 {
        guard let candidate = current else { break }
        guard safeHitTestPressRoles.contains(axRole(candidate)) else {
            current = axElementAttribute(candidate, kAXParentAttribute as CFString)
            continue
        }
        var rawActions: CFArray?
        if AXUIElementCopyActionNames(candidate, &rawActions) == .success,
           let actions = rawActions as? [String],
           actions.contains(kAXPressAction as String) {
            if let bounds = axBounds(candidate), !bounds.isEmpty {
                try movePointerSmoothly(to: CGPoint(x: bounds.midX, y: bounds.midY))
            } else {
                try movePointerSmoothly(to: point)
            }
            _ = try assertInputTarget(row.id)
            if AXUIElementPerformAction(candidate, kAXPressAction as CFString) == .success { return true }
        }
        current = axElementAttribute(candidate, kAXParentAttribute as CFString)
    }
    return false
}

private func validateFrame(_ frame: JSONObject) throws {
    guard let region = rect(frame["region"]) else { throw fail("STALE_FRAME", "the coordinate frame is malformed") }
    if let windowID = number(frame["window"])?.uint32Value {
        guard let row = windowRow(windowID), row.onScreen else {
            throw fail("STALE_FRAME", "target window \(windowID) is no longer drawable")
        }
        let expected = rect(frame["windowGeometry"]) ?? region
        guard row.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) moved or resized after the screenshot")
        }
        guard let after = windowRow(windowID), after.bounds.integral == expected.integral else {
            throw fail("STALE_FRAME", "target window \(windowID) changed geometry while it was activated")
        }
    } else {
        let screen = try virtualScreenRect()
        guard screen.contains(region) else { throw fail("STALE_FRAME", "desktop geometry changed after the screenshot") }
    }
}

private func shareableContent() throws -> SCShareableContent {
    let semaphore = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var failure: Error?
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { value, error in
        content = value
        failure = error
        semaphore.signal()
    }
    guard semaphore.wait(timeout: .now() + 12) == .success else {
        throw fail("CAPTURE_TIMEOUT", "ScreenCaptureKit did not enumerate shareable content in time")
    }
    if let failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
    guard let content else { throw fail("CAPTURE_FAILED", "ScreenCaptureKit returned no shareable content") }
    return content
}

private final class StreamFrameOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    let semaphore = DispatchSemaphore(value: 0)
    let context = CIContext(options: nil)
    var image: CGImage?
    var failure: Error?
    private var finished = false

    private func finish() {
        guard !finished else { return }
        finished = true
        semaphore.signal()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        failure = error
        finish()
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, sampleBuffer.isValid, let pixelBuffer = sampleBuffer.imageBuffer else { return }
        let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
        image = context.createCGImage(ciImage, from: ciImage.extent)
        finish()
    }
}

private func captureImage(filter: SCContentFilter, configuration: SCStreamConfiguration) throws -> CGImage {
    if #available(macOS 14.0, *) {
        let semaphore = DispatchSemaphore(value: 0)
        var image: CGImage?
        var failure: Error?
        SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration) { value, error in
            image = value
            failure = error
            semaphore.signal()
        }
        guard semaphore.wait(timeout: .now() + 15) == .success else {
            throw fail("CAPTURE_TIMEOUT", "the screenshot did not finish in time")
        }
        if let failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
        guard let image else { throw fail("CAPTURE_FAILED", "ScreenCaptureKit returned no image") }
        return image
    }

    let output = StreamFrameOutput()
    let stream = SCStream(filter: filter, configuration: configuration, delegate: output)
    do {
        try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "chat-on-steroids.capture"))
    } catch {
        throw fail("CAPTURE_FAILED", error.localizedDescription)
    }
    let started = DispatchSemaphore(value: 0)
    var startFailure: Error?
    stream.startCapture { error in
        startFailure = error
        started.signal()
    }
    guard started.wait(timeout: .now() + 10) == .success, startFailure == nil else {
        throw fail("CAPTURE_FAILED", startFailure?.localizedDescription ?? "the capture stream did not start")
    }
    guard output.semaphore.wait(timeout: .now() + 15) == .success else {
        stream.stopCapture(completionHandler: nil)
        throw fail("CAPTURE_TIMEOUT", "the capture stream produced no frame")
    }
    stream.stopCapture(completionHandler: nil)
    if let failure = output.failure { throw fail("CAPTURE_FAILED", failure.localizedDescription) }
    guard let image = output.image else { throw fail("CAPTURE_FAILED", "the capture stream produced no image") }
    return image
}

private func writePNG(_ image: CGImage, path: String) throws {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        throw fail("CAPTURE_FAILED", "the PNG destination could not be created")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw fail("CAPTURE_FAILED", "the PNG file could not be written")
    }
}

private func fitPixelBudget(width: Int, height: Int) -> (Int, Int) {
    let safeWidth = max(1, width)
    let safeHeight = max(1, height)
    let pixels = Double(safeWidth) * Double(safeHeight)
    guard pixels > Double(MAX_CAPTURE_PIXELS) else { return (safeWidth, safeHeight) }
    let factor = sqrt(Double(MAX_CAPTURE_PIXELS) / pixels)
    return (
        max(1, Int((Double(safeWidth) * factor).rounded(.down))),
        max(1, Int((Double(safeHeight) * factor).rounded(.down)))
    )
}

private func scaledDimensions(region: CGRect, maxWidth: Int, nativeWidth: Int? = nil) -> (Int, Int) {
    let ceiling = max(1, maxWidth)
    let available = max(1, nativeWidth ?? Int((region.width * 2).rounded()))
    let width = min(ceiling, available)
    let height = max(1, Int((Double(width) * region.height / region.width).rounded()))
    return fitPixelBudget(width: width, height: height)
}

private func resizedImage(_ image: CGImage, width: Int, height: Int) throws -> CGImage {
    if image.width == width && image.height == height { return image }
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: width,
        height: height,
        bitsPerComponent: 8,
        bytesPerRow: width * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw fail("CAPTURE_FAILED", "the scaled screenshot buffer could not be created") }
    context.interpolationQuality = .high
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let scaled = context.makeImage() else { throw fail("CAPTURE_FAILED", "the screenshot could not be scaled") }
    return scaled
}

private func captureWindow(_ windowID: CGWindowID, maxWidth: Int, content: SCShareableContent) throws -> (CGImage, CGRect) {
    guard let window = content.windows.first(where: { $0.windowID == windowID }) else {
        throw fail("WINDOW_NOT_FOUND", "no window with id \(windowID) is available for capture")
    }
    let region = window.frame
    let (width, height) = scaledDimensions(region: region, maxWidth: maxWidth)
    let configuration = SCStreamConfiguration()
    // width/height are available on the ScreenCaptureKit floor (macOS 12.3). Setting them on
    // every supported Desktop host preserves the screenshot/frame aspect mapping.
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = true
    if #available(macOS 14.0, *) { configuration.ignoreShadowsSingleWindow = true }
    let filter = SCContentFilter(desktopIndependentWindow: window)
    let image = try captureImage(filter: filter, configuration: configuration)
    return (try resizedImage(image, width: width, height: height), region)
}

private func captureDisplay(_ display: SCDisplay, maxWidth: Int) throws -> (CGImage, CGRect) {
    let region = display.frame
    let (width, height) = scaledDimensions(region: region, maxWidth: maxWidth, nativeWidth: display.width)
    let configuration = SCStreamConfiguration()
    // width/height are available on the ScreenCaptureKit floor (macOS 12.3). Setting them on
    // every supported Desktop host preserves the screenshot/frame aspect mapping.
    configuration.width = width
    configuration.height = height
    configuration.showsCursor = true
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let image = try captureImage(filter: filter, configuration: configuration)
    return (try resizedImage(image, width: width, height: height), region)
}

private func captureComposite(region target: CGRect, maxWidth: Int, displays: [SCDisplay]) throws -> CGImage {
    let requestedWidth = max(1, min(maxWidth, Int((target.width * 2).rounded())))
    let requestedHeight = max(1, Int((Double(requestedWidth) * target.height / target.width).rounded()))
    let (outputWidth, outputHeight) = fitPixelBudget(width: requestedWidth, height: requestedHeight)
    let scale = CGFloat(outputWidth) / target.width
    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
        data: nil,
        width: outputWidth,
        height: outputHeight,
        bitsPerComponent: 8,
        bytesPerRow: outputWidth * 4,
        space: colorSpace,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw fail("CAPTURE_FAILED", "the composite screenshot buffer could not be created") }
    context.setFillColor(NSColor.black.cgColor)
    context.fill(CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))

    for display in displays where display.frame.intersects(target) {
        let (image, displayRegion) = try captureDisplay(display, maxWidth: display.width)
        let intersection = displayRegion.intersection(target)
        guard !intersection.isNull, !intersection.isEmpty else { continue }
        let imageScaleX = CGFloat(image.width) / displayRegion.width
        let imageScaleY = CGFloat(image.height) / displayRegion.height
        let source = CGRect(
            x: (intersection.minX - displayRegion.minX) * imageScaleX,
            y: (intersection.minY - displayRegion.minY) * imageScaleY,
            width: intersection.width * imageScaleX,
            height: intersection.height * imageScaleY
        ).integral
        guard let cropped = image.cropping(to: source) else { continue }
        let destination = CGRect(
            x: (intersection.minX - target.minX) * scale,
            y: CGFloat(outputHeight) - ((intersection.minY - target.minY + intersection.height) * scale),
            width: intersection.width * scale,
            height: intersection.height * scale
        )
        context.draw(cropped, in: destination)
    }
    guard let image = context.makeImage() else { throw fail("CAPTURE_FAILED", "the composite screenshot was empty") }
    return image
}

private func capture(_ request: JSONObject, forcedWindow: CGWindowID? = nil) throws -> JSONObject {
    try requireScreenCapture()
    let file = string(request["file"])
    guard !file.isEmpty else { throw fail("BAD_REQUEST", "capture needs an output file") }
    let maxWidth = min(2_560, max(1, int(request["maxWidth"], default: 1_280)))
    let screen = try virtualScreenRect()
    let content = try shareableContent()
    let requestedWindow = forcedWindow ?? number(request["id"])?.uint32Value

    var image: CGImage
    var region: CGRect
    var captureMode: String
    if let requestedWindow {
        guard let row = windowRow(requestedWindow) else {
            throw fail("WINDOW_NOT_FOUND", "no window with id \(requestedWindow) is available")
        }
        do {
            (image, region) = try captureWindow(requestedWindow, maxWidth: maxWidth, content: content)
            captureMode = "window"
        } catch let error as HelperFailure {
            // The shared Desktop contract promises an explicitly labelled visible-screen
            // fallback when background window capture is unavailable. Never fake that fallback
            // for a minimized/off-screen target because there are no honest pixels to return.
            guard row.onScreen,
                  error.code == "WINDOW_NOT_FOUND" || error.code == "CAPTURE_FAILED" else {
                throw error
            }
            region = row.bounds
            image = try captureComposite(region: region, maxWidth: maxWidth, displays: content.displays)
            captureMode = "screen_fallback"
        }
    } else if let requestedRegion = rect(request["region"]) {
        region = requestedRegion
        image = try captureComposite(region: region, maxWidth: maxWidth, displays: content.displays)
        captureMode = "screen"
    } else if bool(request["full"]) {
        region = screen
        image = try captureComposite(region: region, maxWidth: maxWidth, displays: content.displays)
        captureMode = "screen"
    } else {
        guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else {
            throw fail("SCREEN_UNAVAILABLE", "ScreenCaptureKit reported no display")
        }
        (image, region) = try captureDisplay(display, maxWidth: maxWidth)
        captureMode = "screen"
    }
    try writePNG(image, path: file)

    // Bind returned pixels to one stable CGWindow geometry. A move/resize racing capture must
    // invalidate the frame instead of combining old pixels with new validation geometry.
    if let requestedWindow {
        guard let row = windowRow(requestedWindow), row.onScreen else {
            throw fail("STALE_FRAME", "target window \(requestedWindow) is no longer drawable after capture")
        }
        guard row.bounds.integral == region.integral else {
            throw fail("STALE_FRAME", "target window \(requestedWindow) moved or resized during capture")
        }
    }
    var response: JSONObject = [
        "region": rectObject(region),
        "image": ["width": image.width, "height": image.height],
        "screen": rectObject(screen),
        "focused": requestedWindow == nil ? NSNull() : foregroundWindowID() == requestedWindow,
        "captureMode": captureMode
    ]
    if requestedWindow != nil {
        // `region` was checked against the fresh CG window immediately above. Keep the same
        // geometry in the frame metadata rather than doing another racy lookup here.
        response["windowGeometry"] = rectObject(region)
    }
    return response
}

private func handle(_ request: JSONObject) throws -> JSONObject {
    let operation = string(request["op"])
    var result: JSONObject = ["ok": true]
    switch operation {
    case "warm":
        result["ready"] = true
        result["screenPermission"] = CGPreflightScreenCaptureAccess()
        result["accessibilityPermission"] = AXIsProcessTrusted()
    case "cursor":
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
    case "windows":
        let foreground = foregroundWindowID()
        result["windows"] = allWindowRows().map { $0.json(foreground: foreground) }
        result["screen"] = rectObject(try virtualScreenRect())
    case "active":
        let foreground = foregroundWindowID()
        result["window"] = foreground.flatMap(windowRow)?.json(foreground: foreground) ?? NSNull()
        result["screen"] = rectObject(try virtualScreenRect())
    case "focus":
        let id = CGWindowID(int(request["id"]))
        try activateInputTarget(id)
        result["focused"] = true
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
    case "find_ui":
        result.merge(try findUI(request)) { _, new in new }
    case "act_ui":
        result.merge(try actUI(request)) { _, new in new }
    case "capture":
        result.merge(try capture(request)) { _, new in new }
    case "snapshot":
        let id = number(request["id"])?.uint32Value ?? foregroundWindowID()
        guard let id, let row = windowRow(id) else {
            throw fail("WINDOW_NOT_FOUND", "no matching visible window is available")
        }
        result["window"] = row.json(foreground: foregroundWindowID())
        if bool(request["includeScreenshot"]) {
            result.merge(try capture(request, forcedWindow: id)) { _, new in new }
        }
        if bool(request["includeUi"]) {
            if AXIsProcessTrusted() {
                let ui = try findUI(request, suppliedWindow: row)
                for key in ["snapshotId", "elements", "visited", "truncated"] {
                    result[key] = ui[key]
                }
            } else if bool(request["includeScreenshot"]) {
                // Screen observation only needs Screen Recording. Do not turn a successful
                // screenshot into a failure or prompt for the stronger Accessibility grant.
                result["snapshotId"] = NSNull()
                result["elements"] = []
                result["visited"] = 0
                result["truncated"] = false
                result["accessibilityNote"] = "Accessibility is not granted; screenshot returned without semantic controls."
            } else {
                try requireAccessibility(prompt: true)
                let ui = try findUI(request, suppliedWindow: row)
                for key in ["snapshotId", "elements", "visited", "truncated"] {
                    result[key] = ui[key]
                }
            }
        }
    case "act":
        try requireAccessibility(prompt: true)
        if let frame = request["frame"] as? JSONObject { try validateFrame(frame) }
        let actions = request["actions"] as? [JSONObject] ?? []
        var leasedWindow = number(request["targetWindow"])?.uint32Value
        if leasedWindow == nil, let frame = request["frame"] as? JSONObject {
            leasedWindow = number(frame["window"])?.uint32Value
        }
        var routes: [String] = []
        var completed = 0
        for (index, action) in actions.enumerated() {
            do {
                let type = string(action["type"])
                switch type {
                case "click_ui", "set_value_ui":
                    guard let actionWindow = number(action["window"])?.uint32Value else {
                        throw fail("BAD_ACTION", "semantic action is missing its target window")
                    }
                    if let leasedWindow, leasedWindow != actionWindow {
                        throw fail("TARGET_WINDOW_CONFLICT", "semantic action targets window \(actionWindow), but this batch is pinned to window \(leasedWindow)")
                    }
                    leasedWindow = actionWindow
                    if type == "click_ui" { _ = try assertInputTarget(actionWindow) }
                    var uiRequest = action
                    uiRequest["id"] = action["window"]
                    uiRequest["action"] = type == "click_ui" ? "click" : "set_value"
                    uiRequest["value"] = action["value"]
                    let reply = try actUI(uiRequest)
                    routes.append(string(reply["route"], default: "uia"))
                case "move":
                    guard let leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "pointer input requires a target window; no input was sent")
                    }
                    _ = try assertInputTarget(leasedWindow)
                    try movePointerSmoothly(to: CGPoint(x: int(action["x"]), y: int(action["y"])))
                    routes.append("sendinput")
                case "click", "double_click":
                    guard let leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "click input requires a target window; no input was sent")
                    }
                    _ = try assertInputTarget(leasedWindow)
                    let point = CGPoint(x: int(action["x"]), y: int(action["y"]))
                    let button = mouseButton(string(action["button"]))
                    if type == "click", button == .left, let row = windowRow(leasedWindow),
                       try tryPressElement(at: point, target: row) {
                        routes.append("uia")
                    } else {
                        _ = try assertInputTarget(leasedWindow)
                        try click(point, button: button, count: type == "double_click" ? 2 : 1, targetWindow: leasedWindow)
                        routes.append("sendinput")
                    }
                case "scroll":
                    guard let leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "scroll input requires a target window; no input was sent")
                    }
                    _ = try assertInputTarget(leasedWindow)
                    try movePointerSmoothly(to: CGPoint(x: int(action["x"]), y: int(action["y"])))
                    _ = try assertInputTarget(leasedWindow)
                    guard let event = CGEvent(
                        scrollWheelEvent2Source: nil,
                        units: .line,
                        wheelCount: 2,
                        wheel1: Int32(-int(action["scroll_y"])),
                        wheel2: Int32(int(action["scroll_x"])),
                        wheel3: 0
                    ) else { throw fail("INPUT_FAILED", "could not create a scroll event") }
                    event.post(tap: .cghidEventTap)
                    routes.append("sendinput")
                case "drag":
                    guard let leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "drag input requires a target window; no input was sent")
                    }
                    _ = try assertInputTarget(leasedWindow)
                    try drag(
                        action["xs"] as? [NSNumber] ?? [],
                        action["ys"] as? [NSNumber] ?? [],
                        button: mouseButton(string(action["button"])),
                        targetWindow: leasedWindow
                    )
                    routes.append("sendinput")
                case "type":
                    guard let leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "text input requires a target window; no input was sent")
                    }
                    _ = try assertInputTarget(leasedWindow)
                    try typeText(string(action["text"]), targetWindow: leasedWindow)
                    routes.append("sendinput")
                case "keypress":
                    guard let leasedWindow else {
                        throw fail("INPUT_TARGET_REQUIRED", "keyboard input requires a target window; no input was sent")
                    }
                    _ = try assertInputTarget(leasedWindow)
                    try pressKeys(action["keys"] as? [String] ?? [], targetWindow: leasedWindow)
                    routes.append("sendinput")
                case "focus":
                    let requested = CGWindowID(int(action["window"]))
                    if let leasedWindow, leasedWindow != requested {
                        throw fail("TARGET_WINDOW_CONFLICT", "focus targets window \(requested), but this batch is pinned to window \(leasedWindow)")
                    }
                    leasedWindow = requested
                    try activateInputTarget(requested)
                    routes.append("focus")
                default:
                    throw fail("BAD_ACTION", "unknown action \(type)")
                }
                completed += 1
            } catch let error as HelperFailure {
                return [
                    "ok": false,
                    "error_code": error.code,
                    "message": error.message,
                    "completed_count": completed,
                    "failed_index": index,
                    "routes": routes
                ]
            }
        }
        result["cursor"] = cursorObject()
        result["foreground"] = foregroundWindowID().map(Int.init) ?? 0
        result["completed_count"] = completed
        result["routes"] = routes
    default:
        throw fail("BAD_REQUEST", "unknown operation \(operation)")
    }
    return result
}

private func response(for line: String) -> JSONObject {
    do {
        guard let data = line.data(using: .utf8),
              let request = try JSONSerialization.jsonObject(with: data) as? JSONObject else {
            throw fail("BAD_REQUEST", "request is not a JSON object")
        }
        return try handle(request)
    } catch let error as HelperFailure {
        return ["ok": false, "error_code": error.code, "message": error.message]
    } catch {
        return ["ok": false, "error_code": "HELPER_ERROR", "message": error.localizedDescription]
    }
}

private func writeResponse(_ response: JSONObject) {
    do {
        let data = try JSONSerialization.data(withJSONObject: response)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    } catch {
        let fallback = "{\"ok\":false,\"error_code\":\"HELPER_ERROR\",\"message\":\"response serialization failed\"}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
    }
}

@main
private enum MacOSDesktopHelperMain {
    static func main() {
        while let line = readLine() {
            if line.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { continue }
            autoreleasepool {
                writeResponse(response(for: line))
            }
        }
    }
}
