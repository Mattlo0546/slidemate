// SlideMate AirDrop helper.
//   SlideMateAirDrop <file...> [--device NAME] [--status PATH]   open AirDrop panel, auto-click NAME if permitted
//   SlideMateAirDrop --trust|--check [--status PATH]              report Accessibility permission (--trust also prompts)
import Cocoa
import ApplicationServices

var files: [URL] = []
var device: String? = nil
var statusPath: String? = nil
var trustOnly = false
var promptTrust = false
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let a = args.removeFirst()
    switch a {
    case "--device": if !args.isEmpty { device = args.removeFirst() }
    case "--status": if !args.isEmpty { statusPath = args.removeFirst() }
    case "--trust": trustOnly = true; promptTrust = true
    case "--check": trustOnly = true
    default: if !a.hasPrefix("-psn") { files.append(URL(fileURLWithPath: a)) }
    }
}

var status: [String: Any] = [:]
func report(_ kv: [String: Any]) {
    kv.forEach { status[$0.key] = $0.value }
    guard let p = statusPath, let data = try? JSONSerialization.data(withJSONObject: status) else { return }
    try? data.write(to: URL(fileURLWithPath: p))
}

func attr(_ e: AXUIElement, _ name: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, name as CFString, &v) == .success ? v : nil
}
func label(_ e: AXUIElement) -> String {
    [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute]
        .compactMap { attr(e, $0 as String) as? String }.joined(separator: " | ")
}
func walk(_ e: AXUIElement, _ depth: Int, _ visit: (AXUIElement) -> Bool) -> Bool {
    if visit(e) { return true }
    guard depth < 40, let kids = attr(e, kAXChildrenAttribute as String) as? [AXUIElement] else { return false }
    for k in kids where walk(k, depth + 1, visit) { return true }
    return false
}
func norm(_ s: String) -> String {
    s.lowercased().replacingOccurrences(of: "\u{2019}", with: "'").split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
}
func frame(_ e: AXUIElement) -> CGRect? {
    guard let p = attr(e, kAXPositionAttribute as String), let s = attr(e, kAXSizeAttribute as String) else { return nil }
    var pt = CGPoint.zero, sz = CGSize.zero
    AXValueGetValue(p as! AXValue, .cgPoint, &pt)
    AXValueGetValue(s as! AXValue, .cgSize, &sz)
    return sz.width > 0 && sz.height > 0 ? CGRect(origin: pt, size: sz) : nil
}
func click(_ r: CGRect) {
    let pt = CGPoint(x: r.midX, y: r.midY)
    let src = CGEventSource(stateID: .hidSystemState)
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
        usleep(40_000)
    }
}
func press(_ e: AXUIElement) -> String? {
    var cur: AXUIElement? = e
    for _ in 0..<4 {  // the label may sit on a child of the clickable element
        guard let c = cur else { break }
        if AXUIElementPerformAction(c, kAXPressAction as CFString) == .success { return "axpress" }
        cur = attr(c, kAXParentAttribute as String) as! AXUIElement?
    }
    if let r = frame(e) { click(r); return "click" }  // fall back to a real click on the device tile
    return nil
}
// The AirDrop panel is a remote view drawn by system share-sheet processes, so search those too.
func panelRoots() -> [(String, AXUIElement)] {
    var roots: [(String, AXUIElement)] = [("self", AXUIElementCreateApplication(getpid()))]
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-axo", "pid=,comm="]
    let pipe = Pipe()
    ps.standardOutput = pipe
    try? ps.run()
    let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
    for line in out.split(separator: "\n") {
        let parts = line.trimmingCharacters(in: .whitespaces).split(separator: " ", maxSplits: 1)
        guard parts.count == 2, let pid = pid_t(parts[0]) else { continue }
        let comm = String(parts[1])
        if comm.hasSuffix("/ShareSheetUI") || comm.hasSuffix("AirDrop.appex/Contents/MacOS/AirDrop") || comm.hasSuffix("/AirDropUIAgent") {
            roots.append((URL(fileURLWithPath: comm).lastPathComponent, AXUIElementCreateApplication(pid)))
        }
    }
    return roots
}

let trusted = AXIsProcessTrustedWithOptions(
    [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: promptTrust] as CFDictionary)
report(["trusted": trusted])
if trustOnly { exit(trusted ? 0 : 1) }

class D: NSObject, NSSharingServiceDelegate {
    func sharingService(_ s: NSSharingService, didFailToShareItems items: [Any], error: Error) {
        report(["state": "failed", "error": error.localizedDescription]); exit(2)
    }
}
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let d = D()
guard let svc = NSSharingService(named: .sendViaAirDrop), svc.canPerform(withItems: files) else {
    report(["state": "failed", "error": "AirDrop unavailable (is Wi-Fi/Bluetooth on?)"]); exit(3)
}
svc.delegate = d
DispatchQueue.main.async {
    app.activate(ignoringOtherApps: true)
    svc.perform(withItems: files)
    report(["state": "panel"])
}

var ticks = 0
var sawWindow = false
Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
    ticks += 1
    let visible = app.windows.contains { $0.isVisible }
    if visible { sawWindow = true }
    if sawWindow && !visible { exit(0) }            // panel closed (sent or cancelled)
    if ticks > 240 { report(["state": "timeout"]); exit(4) }  // 60s
    guard let dev = device.map(norm), !dev.isEmpty, trusted, sawWindow, ticks % 2 == 0 else { return }
    // Also accept the name without a "(2)"-style suffix, which macOS adds when two devices share a name.
    let base = dev.replacingOccurrences(of: #"\s*\(\d+\)$"#, with: "", options: .regularExpression)
    let wanted = base == dev ? [dev] : [dev, base]
    var names: [String] = []
    var hit: AXUIElement? = nil
    for (proc, root) in panelRoots() {
        _ = walk(root, 0) { e in
            let l = label(e)
            if !l.isEmpty { names.append("\(proc): \(l)") }
            let nl = norm(l)
            if wanted.contains(where: { nl.contains($0) }) { hit = e; return true }
            return false
        }
        if hit != nil { break }
    }
    if let h = hit, let how = press(h) {
        report(["state": "clicked", "device": device!, "how": how]); device = nil
    } else if ticks % 8 == 0 {
        report(["seen": Array(names.prefix(80))])
    }
}
app.run()
