// SlideMate for macOS: a native window around the local SlideMate server.
//
// On launch it starts `server/server.py` (bundled in Contents/Resources) with the system Python 3,
// waits for it to answer, then shows the UI in a WKWebView. Quitting the app stops the server.
import Cocoa
import Darwin
import UniformTypeIdentifiers
import WebKit

let port = ProcessInfo.processInfo.environment["SLIDEMATE_PORT"] ?? "8767"
let base = URL(string: "http://127.0.0.1:\(port)/")!
let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/SlideMate")

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSAlertDelegate {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var pendingFile: String?
    var ready = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
        if offerMoveToApplications() { return }  // relaunching from Applications
        let cfg = WKWebViewConfiguration()
        cfg.preferences.setValue(true, forKey: "developerExtrasEnabled")  // right-click → Inspect Element
        cfg.userContentController.add(self, name: "slidemate")             // native helpers for the web UI
        web = WKWebView(frame: .zero, configuration: cfg)
        web.uiDelegate = self
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "SlideMate"
        window.minSize = NSSize(width: 900, height: 560)
        window.contentView = web
        window.delegate = self
        if !window.setFrameUsingName("SlideMateMain") { window.center() }
        window.setFrameAutosaveName("SlideMateMain")
        window.makeKeyAndOrderFront(nil)
        showSplash()

        startServer { [weak self] ok, detail in
            guard let self = self else { return }
            if ok {
                self.ready = true
                self.load(file: self.pendingFile)
                self.scheduleUpdateChecks()
            } else {
                self.showMessage("SlideMate couldn't start its local server.", detail: detail)
            }
        }
    }

    func load(file: String?) {
        var comps = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        if let f = file { comps.queryItems = [URLQueryItem(name: "file", value: f)] }
        web.load(URLRequest(url: comps.url!))
    }

    // Open PDFs dropped on the Dock icon or via Open With.
    func application(_ app: NSApplication, open urls: [URL]) {
        guard let pdf = urls.first(where: { $0.pathExtension.lowercased() == "pdf" }) else { return }
        if ready { load(file: pdf.path) } else { pendingFile = pdf.path }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    // MARK: don't lose a lecture recording

    var quitConfirmed = false

    /// Asks the page whether a lecture is being recorded. If so, offers to keep recording or to stop (saving the
    /// audio and writing notes) before going ahead. `proceed` is called only if it's OK to quit/close.
    func confirmIfRecording(action: String, proceed: @escaping () -> Void, cancel: @escaping () -> Void) {
        guard ready, !quitConfirmed else { return proceed() }
        web.evaluateJavaScript("window.__slidemateRecording ? window.__slidemateRecording() : {recording:false}") { [weak self] result, _ in
            guard let self = self else { return }
            let info = result as? [String: Any]
            guard (info?["recording"] as? Bool) == true else { return proceed() }
            let secs = (info?["seconds"] as? Int) ?? 0
            let alert = NSAlert()
            alert.alertStyle = .warning
            alert.messageText = "A lecture is being recorded"
            alert.informativeText = "You've recorded \(secs / 60) min \(secs % 60) s. If you \(action) now, SlideMate stops the recording "
                + (action == "reload" ? "and saves the audio, then writes your notes." : "and saves the audio. Your notes are written next time SlideMate is open.")
            alert.addButton(withTitle: "Keep Recording")
            alert.addButton(withTitle: "Stop & \(action.capitalized)")
            if alert.runModal() == .alertFirstButtonReturn { return cancel() }
            self.quitConfirmed = true
            // Finish the recording properly (flush the last audio, start transcription) before quitting.
            self.web.callAsyncJavaScript("return await window.__slidemateStopRecording()", arguments: [:], in: nil, in: .page) { _ in
                proceed()
            }
        }
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard ready, !quitConfirmed else { return .terminateNow }
        confirmIfRecording(action: "quit", proceed: { NSApp.reply(toApplicationShouldTerminate: true) },
                           cancel: { NSApp.reply(toApplicationShouldTerminate: false) })
        return .terminateLater
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        guard ready, !quitConfirmed else { return true }
        confirmIfRecording(action: "close", proceed: { [weak self] in self?.quitConfirmed = true; sender.close() }, cancel: {})
        return false
    }
    func applicationWillTerminate(_ note: Notification) { server?.terminate() }

    // MARK: server

    func healthy(_ done: @escaping (Bool) -> Void) {
        var req = URLRequest(url: base.appendingPathComponent("api/health"))
        req.timeoutInterval = 1
        URLSession.shared.dataTask(with: req) { data, _, _ in
            done(data.flatMap { String(data: $0, encoding: .utf8) }?.contains("slidemate") == true)
        }.resume()
    }

    func startServer(_ done: @escaping (Bool, String) -> Void) {
        healthy { up in
            if up { return DispatchQueue.main.async { done(true, "") } }  // already running (e.g. dev server)
            DispatchQueue.main.async { self.spawnServer(done) }
        }
    }

    func spawnServer(_ done: @escaping (Bool, String) -> Void) {
        let res = Bundle.main.resourceURL!
        let env = ProcessInfo.processInfo.environment
        let script = env["SLIDEMATE_SERVER"].map { URL(fileURLWithPath: $0) } ?? res.appendingPathComponent("server/server.py")
        // The app carries its own Python (scripts/build-app.sh). The rest is for builds without it, e.g. an
        // older checkout: /usr/bin/python3 is only a stub until the Xcode Command Line Tools are installed.
        let bundled = res.appendingPathComponent("python/bin/python3").path
        let cltInstalled = FileManager.default.fileExists(atPath: "/Library/Developer/CommandLineTools/usr/bin/python3")
            || FileManager.default.fileExists(atPath: "/Applications/Xcode.app/Contents/Developer/usr/bin/python3")
        let pythons = [bundled, "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] + (cltInstalled ? ["/usr/bin/python3"] : [])
        guard let python = pythons.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return installCommandLineTools { [weak self] in self?.spawnServer(done) }
        }
        if python == bundled {
            // While the app's files still carry the download's quarantine flag, macOS kills programs inside it
            // (like the bundled Python) that it starts. The app is running, so the user approved it: clear the flag.
            let x = Process()
            x.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
            x.arguments = ["-dr", "com.apple.quarantine", Bundle.main.bundleURL.path]
            x.standardError = FileHandle.nullDevice
            try? x.run(); x.waitUntilExit()
        }
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logURL = logDir.appendingPathComponent("server.log")
        FileManager.default.createFile(atPath: logURL.path, contents: nil)
        let log = try? FileHandle(forWritingTo: logURL)

        let p = Process()
        p.executableURL = URL(fileURLWithPath: python)
        p.arguments = [script.path]
        p.currentDirectoryURL = script.deletingLastPathComponent()
        var penv = env
        penv["SLIDEMATE_PORT"] = port
        penv["SLIDEMATE_HELPER"] = res.appendingPathComponent("Helpers/SlideMateAirDrop.app").path
        penv["PYTHONUNBUFFERED"] = "1"
        penv["PYTHONDONTWRITEBYTECODE"] = "1"  // never write .pyc files into the (signed) app bundle
        if python == bundled { ["PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"].forEach { penv.removeValue(forKey: $0) } }
        penv["SLIDEMATE_PARENT_PID"] = String(ProcessInfo.processInfo.processIdentifier)  // server exits if the app dies
        p.environment = penv
        p.standardOutput = log
        p.standardError = log
        do { try p.run() } catch { return done(false, "\(error)") }
        server = p

        var tries = 0
        func poll() {
            healthy { up in
                DispatchQueue.main.async {
                    if up { return done(true, "") }
                    tries += 1
                    if !p.isRunning || tries > 80 {
                        let tail = (try? String(contentsOf: logURL, encoding: .utf8)).map { String($0.suffix(1500)) } ?? ""
                        return done(false, tail.isEmpty ? "No output. See \(logURL.path)" : tail)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: poll)
                }
            }
        }
        poll()
    }

    /// SlideMate runs on the Python that comes with Apple's free Command Line Tools. `xcode-select --install`
    /// shows Apple's own installer dialog; once it has finished, carry on starting up.
    func installCommandLineTools(then next: @escaping () -> Void) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/xcode-select")
        p.arguments = ["--install"]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
        showMessage("One more thing: Apple's Command Line Tools",
                    note: "SlideMate runs on Python, which comes with Apple's free Command Line Tools. Click <b>Install</b> in the "
                        + "window that just opened and agree to the licence. It takes 5–10 minutes, and SlideMate starts by itself "
                        + "when it's done.<br><br>Don't see the window? Quit and reopen SlideMate.")
        func wait() {
            let ready = ["/Library/Developer/CommandLineTools/usr/bin/python3", "/Applications/Xcode.app/Contents/Developer/usr/bin/python3",
                         "/opt/homebrew/bin/python3", "/usr/local/bin/python3"].contains { FileManager.default.isExecutableFile(atPath: $0) }
            if ready { return next() }
            DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: wait)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5, execute: wait)
    }

    /// The logo while the server starts (usually under a second), so the first thing anyone sees isn't a blank window.
    func showSplash() {
        let logo = (try? String(contentsOf: Bundle.main.resourceURL!.appendingPathComponent("server/static/logo.svg"), encoding: .utf8)) ?? ""
        web.loadHTMLString("""
        <html><body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:transparent">
        <div style="width:64px;height:64px;animation:p 1.6s ease-in-out infinite">\(logo)</div>
        <style>svg{width:64px;height:64px}@keyframes p{50%{opacity:.55;transform:scale(.96)}}</style></body></html>
        """, baseURL: nil)
    }

    func showMessage(_ title: String, detail: String = "", note: String = "") {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let noteHTML = note.isEmpty ? "" : "<p style='line-height:1.5'>\(note)</p>"
        let html = """
        <html><body style="font:14px -apple-system;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
        color:#888;background:transparent"><div style="max-width:640px;text-align:center"><p style="font-size:15px;color:#999">\(esc(title))</p>\(noteHTML)
        <pre style="text-align:left;white-space:pre-wrap;font:11px Menlo;color:#888">\(esc(detail))</pre></div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    // MARK: move to Applications
    //
    // A downloaded SlideMate often starts from Downloads (or from the disk image). macOS then runs it from a
    // temporary read-only copy ("App Translocation"), where it can't update itself. Like most Mac apps, offer to
    // move it to Applications once, then relaunch from there, without the download's quarantine flag, so macOS
    // doesn't ask again.

    /// Returns true when SlideMate is relaunching from Applications (so this copy should do nothing else).
    func offerMoveToApplications() -> Bool {
        let fm = FileManager.default
        let here = Bundle.main.bundleURL.resolvingSymlinksInPath()
        let home = fm.homeDirectoryForCurrentUser.path
        let inApps = ["/Applications/", home + "/Applications/"].contains { here.path.hasPrefix($0) }
        let translocated = here.path.contains("/AppTranslocation/")
        let original = translocated ? (Self.originalURL(of: here) ?? here) : here
        guard !inApps, here.pathExtension == "app", !UserDefaults.standard.bool(forKey: "neverMoveToApplications"),
              ProcessInfo.processInfo.environment["SLIDEMATE_SERVER"] == nil,
              !original.path.contains("/build/"), !original.path.contains("/DerivedData/") else { return false }

        let alert = NSAlert()
        alert.messageText = "Move SlideMate to your Applications folder?"
        alert.informativeText = "SlideMate keeps itself up to date from there, and you'll find it in Launchpad and Spotlight."
        alert.addButton(withTitle: "Move to Applications")
        alert.addButton(withTitle: "Not Now")
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = "Don't ask again"
        NSApp.activate(ignoringOtherApps: true)
        let answer = alert.runModal()
        if alert.suppressionButton?.state == .on { UserDefaults.standard.set(true, forKey: "neverMoveToApplications") }
        guard answer == .alertFirstButtonReturn else { return false }

        var apps = URL(fileURLWithPath: "/Applications")
        if !fm.isWritableFile(atPath: apps.path) {
            apps = fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications")
            try? fm.createDirectory(at: apps, withIntermediateDirectories: true)
        }
        let dest = apps.appendingPathComponent("SlideMate.app")
        do {
            if fm.fileExists(atPath: dest.path) { try fm.trashItem(at: dest, resultingItemURL: nil) }  // an older copy
            try fm.copyItem(at: here, to: dest)
        } catch {
            let a = NSAlert()
            a.messageText = "SlideMate couldn't move itself"
            a.informativeText = "Drag SlideMate into your Applications folder in Finder instead.\n\n\(error.localizedDescription)"
            a.runModal()
            return false
        }
        // The copy is ours now: no quarantine flag means no "downloaded from the internet" prompt from Applications.
        let x = Process()
        x.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
        x.arguments = ["-dr", "com.apple.quarantine", dest.path]
        try? x.run(); x.waitUntilExit()
        // Tidy up the copy in Downloads (not a disk image, which is read-only, or anything we can't write).
        if fm.isWritableFile(atPath: original.deletingLastPathComponent().path), !original.path.hasPrefix("/Volumes/") {
            try? fm.trashItem(at: original, resultingItemURL: nil)
        }
        let open = Process()
        open.executableURL = URL(fileURLWithPath: "/bin/sh")
        open.arguments = ["-c", "sleep 0.7; /usr/bin/open \"$0\"", dest.path]
        try? open.run()
        NSApp.terminate(nil)
        return true
    }

    /// Where a translocated app really is (Security's SecTranslocateCreateOriginalPathForURL, looked up at runtime).
    static func originalURL(of url: URL) -> URL? {
        guard let h = dlopen("/System/Library/Frameworks/Security.framework/Security", RTLD_LAZY),
              let sym = dlsym(h, "SecTranslocateCreateOriginalPathForURL") else { return nil }
        typealias Fn = @convention(c) (CFURL, UnsafeMutablePointer<Unmanaged<CFError>?>?) -> Unmanaged<CFURL>?
        let fn = unsafeBitCast(sym, to: Fn.self)
        return fn(url as CFURL, nil)?.takeRetainedValue() as URL?
    }

    // MARK: web view behaviour

    // Allow the microphone for lecture recording (local UI only).
    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .deny)
    }

    // External links open in the default browser.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let url = action.request.url, let host = url.host, host != "127.0.0.1", url.scheme?.hasPrefix("http") == true {
            NSWorkspace.shared.open(url)
            return decisionHandler(.cancel)
        }
        decisionHandler(.allow)
    }

    // <input type="file"> does nothing in WKWebView unless the app shows the panel. WebKit doesn't pass on the
    // input's `accept`, so the page sets window.__openPanel = "json" before opening the Google Classroom client
    // file; anything else is "attach pictures" in the chat.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        webView.evaluateJavaScript("(() => { const k = window.__openPanel || ''; window.__openPanel = ''; return k })()") { kind, _ in
            let panel = NSOpenPanel()
            panel.allowsMultipleSelection = parameters.allowsMultipleSelection
            panel.canChooseDirectories = false
            if (kind as? String) == "json" {
                panel.allowedContentTypes = [.json]
                panel.message = "Choose the client file you downloaded from Google Cloud (client_secret_….json)"
                panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
            } else {
                panel.allowedContentTypes = [.image]
                panel.message = "Choose pictures to ask about, e.g. photos of your handwritten notes"
            }
            guard let w = webView.window else { return completionHandler(panel.runModal() == .OK ? panel.urls : nil) }
            panel.beginSheetModal(for: w) { r in completionHandler(r == .OK ? panel.urls : nil) }
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = message; a.runModal(); completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = message
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let a = NSAlert(); a.messageText = prompt
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.stringValue = defaultText ?? ""
        a.accessoryView = field
        a.addButton(withTitle: "OK"); a.addButton(withTitle: "Cancel")
        completionHandler(a.runModal() == .alertFirstButtonReturn ? field.stringValue : nil)
    }

    // Native helpers for the web UI: window.webkit.messageHandlers.slidemate.postMessage({action: …})
    //   "pickFolder": folder picker for the setup screen
    //   "snapshot":   screenshot of part of the window (snipping the chat), {x, y, w, h} in page pixels
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let action = body["action"] as? String else { return }
        if action == "snapshot" { return snapshot(body) }
        guard action == "pickFolder" else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Choose"
        panel.message = "Choose the folder that holds your course folders"
        panel.beginSheetModal(for: window) { [weak self] resp in
            let path = resp == .OK ? panel.url?.path : nil
            let value: Any = path.map { $0 as Any } ?? NSNull()
            let json = (try? JSONSerialization.data(withJSONObject: [value])).flatMap { String(data: $0, encoding: .utf8) } ?? "[null]"
            self?.web.evaluateJavaScript("window.__slidemateFolder && window.__slidemateFolder(\(json)[0])")
        }
    }

    func snapshot(_ body: [String: Any]) {
        let num = { (k: String) in CGFloat((body[k] as? NSNumber)?.doubleValue ?? 0) }
        let cfg = WKSnapshotConfiguration()
        cfg.rect = CGRect(x: num("x"), y: num("y"), width: num("w"), height: num("h"))
        cfg.afterScreenUpdates = true
        web.takeSnapshot(with: cfg) { [weak self] image, _ in
            var url = "null"
            if let cg = image?.cgImage(forProposedRect: nil, context: nil, hints: nil),
               let png = NSBitmapImageRep(cgImage: cg).representation(using: .png, properties: [:]) {
                url = "\"data:image/png;base64,\(png.base64EncodedString())\""
            }
            self?.web.evaluateJavaScript("window.__slidemateSnapshot && window.__slidemateSnapshot(\(url))")
        }
    }

    // MARK: updates
    //
    // Checks the latest GitHub release once a day. If it's newer, offers to download it, swap it in for this
    // copy of SlideMate and relaunch. The app is ad-hoc signed, but a file downloaded with URLSession isn't
    // quarantined, so the new copy opens without the Gatekeeper prompt the first download needed.

    let releasesAPI = URL(string: "https://api.github.com/repos/Mattlo0546/slidemate/releases/latest")!
    let currentVersion = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
    var checkingForUpdates = false

    struct Release { let version: String; let notes: String; let page: URL; let zip: URL? }

    func scheduleUpdateChecks() {
        guard ProcessInfo.processInfo.environment["SLIDEMATE_NO_UPDATE_CHECK"] == nil else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 8) { [weak self] in self?.checkForUpdates(userInitiated: false) }
        // SlideMate often stays open for days, so check again every few hours (at most once a day).
        Timer.scheduledTimer(withTimeInterval: 4 * 3600, repeats: true) { [weak self] _ in self?.checkForUpdates(userInitiated: false) }
    }

    @objc func checkForUpdatesMenu() { checkForUpdates(userInitiated: true) }

    func checkForUpdates(userInitiated: Bool) {
        let defaults = UserDefaults.standard
        if !userInitiated, let last = defaults.object(forKey: "lastUpdateCheck") as? Date, Date().timeIntervalSince(last) < 20 * 3600 { return }
        guard !checkingForUpdates else { return }
        checkingForUpdates = true
        var req = URLRequest(url: releasesAPI)
        req.timeoutInterval = 15
        req.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            DispatchQueue.main.async {
                guard let self = self else { return }
                self.checkingForUpdates = false
                guard (resp as? HTTPURLResponse)?.statusCode == 200, let data = data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let tag = json["tag_name"] as? String,
                      let page = (json["html_url"] as? String).flatMap(URL.init(string:)) else {
                    if userInitiated { self.updateAlert("Couldn't check for updates", "GitHub didn't answer. Check your internet connection and try again.") }
                    return
                }
                defaults.set(Date(), forKey: "lastUpdateCheck")
                let version = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
                let zip = (json["assets"] as? [[String: Any]] ?? [])
                    .first { ($0["name"] as? String)?.hasSuffix("-macOS.zip") == true }
                    .flatMap { ($0["browser_download_url"] as? String).flatMap(URL.init(string:)) }
                let release = Release(version: version, notes: Self.plainNotes(json["body"] as? String ?? ""), page: page, zip: zip)
                if Self.isNewer(version, than: self.currentVersion) {
                    if userInitiated || defaults.string(forKey: "skippedVersion") != version { self.offerUpdate(release, userInitiated: userInitiated) }
                } else if userInitiated {
                    self.updateAlert("You're up to date", "SlideMate \(self.currentVersion) is the latest version.")
                }
            }
        }.resume()
    }

    static func isNewer(_ a: String, than b: String) -> Bool {
        let parts = { (s: String) in s.split(separator: ".").map { Int($0.prefix { $0.isNumber }) ?? 0 } }
        let x = parts(a), y = parts(b)
        for i in 0..<max(x.count, y.count) {
            let p = i < x.count ? x[i] : 0, q = i < y.count ? y[i] : 0
            if p != q { return p > q }
        }
        return false
    }

    /// The release notes as plain text for an alert: no images/HTML, no install section, no markdown markers.
    static func plainNotes(_ body: String) -> String {
        var lines: [String] = []
        for raw in body.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("### Install") || line.hasPrefix("**Full Changelog") { break }
            if line.hasPrefix("<") || line.isEmpty && (lines.last?.isEmpty ?? true) { continue }
            var clean = line.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            if clean.hasPrefix("### ") { clean = String(clean.dropFirst(4)) }
            if clean.hasPrefix("- ") { clean = "• " + clean.dropFirst(2) }
            else if clean.range(of: #"^\d+\. "#, options: .regularExpression) != nil { }  // numbered steps keep their own line
            else if !clean.isEmpty, let last = lines.last, !last.isEmpty, !raw.hasPrefix("#") {
                lines[lines.count - 1] = last + " " + clean; continue  // a wrapped line continues the one above
            }
            lines.append(clean)
        }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count > 900 ? String(text.prefix(900)) + "…" : text
    }

    func updateAlert(_ title: String, _ text: String) {
        let a = NSAlert(); a.messageText = title; a.informativeText = text
        a.beginSheetModal(for: window)
    }

    func offerUpdate(_ r: Release, userInitiated: Bool) {
        guard window.attachedSheet == nil else { return }  // don't stack on top of another dialog; ask next time
        let a = NSAlert()
        a.messageText = "SlideMate \(r.version) is available"
        a.informativeText = "You have \(currentVersion).\n\n\(r.notes)"
        a.addButton(withTitle: "Install and Relaunch")
        a.addButton(withTitle: "Later")
        a.addButton(withTitle: "Skip This Version")
        a.showsHelp = true  // the (?) button opens the full release notes
        a.delegate = self
        releasePage = r.page
        a.beginSheetModal(for: window) { [weak self] resp in
            switch resp {
            case .alertFirstButtonReturn: self?.installUpdate(r)
            case .alertThirdButtonReturn: UserDefaults.standard.set(r.version, forKey: "skippedVersion")
            default: break
            }
        }
    }

    var releasePage: URL?
    func alertShowHelp(_ alert: NSAlert) -> Bool {
        if let u = releasePage { NSWorkspace.shared.open(u) }
        return true
    }

    func installUpdate(_ r: Release) {
        let dest = Bundle.main.bundleURL
        let parent = dest.deletingLastPathComponent()
        // Not installed somewhere we can replace (e.g. run from the Downloads zip or a read-only disk image):
        // just open the release page.
        guard let zip = r.zip, dest.pathExtension == "app", FileManager.default.isWritableFile(atPath: parent.path),
              !dest.path.hasPrefix("/private/var/folders") /* App Translocation */ else {
            NSWorkspace.shared.open(r.page); return
        }
        web.evaluateJavaScript("window.__slidemateRecording ? window.__slidemateRecording() : {recording:false}") { [weak self] result, _ in
            guard let self = self else { return }
            if ((result as? [String: Any])?["recording"] as? Bool) == true {
                return self.updateAlert("Finish recording first", "SlideMate can't update while a lecture is being recorded. Stop the recording, then choose SlideMate → Check for Updates….")
            }
            self.window.title = "SlideMate — downloading \(r.version)…"
            URLSession.shared.downloadTask(with: zip) { file, resp, err in
                let fail = { (why: String) in DispatchQueue.main.async {
                    self.window.title = "SlideMate"
                    let a = NSAlert(); a.messageText = "The update didn't install"
                    a.informativeText = "\(why)\n\nYou can download it from GitHub instead."
                    a.addButton(withTitle: "Open GitHub"); a.addButton(withTitle: "Cancel")
                    a.beginSheetModal(for: self.window) { if $0 == .alertFirstButtonReturn { NSWorkspace.shared.open(r.page) } }
                } }
                guard let file = file, (resp as? HTTPURLResponse)?.statusCode == 200 else { return fail(err?.localizedDescription ?? "The download failed.") }
                let fm = FileManager.default
                let work = fm.temporaryDirectory.appendingPathComponent("SlideMate-update-\(r.version)-\(UUID().uuidString.prefix(6))")
                try? fm.createDirectory(at: work, withIntermediateDirectories: true)
                let unzip = Process()
                unzip.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
                unzip.arguments = ["-x", "-k", file.path, work.path]
                do { try unzip.run(); unzip.waitUntilExit() } catch { return fail("Couldn't unzip the download.") }
                let app = work.appendingPathComponent("SlideMate.app")
                let info = NSDictionary(contentsOf: app.appendingPathComponent("Contents/Info.plist"))
                guard unzip.terminationStatus == 0, info?["CFBundleIdentifier"] as? String == Bundle.main.bundleIdentifier,
                      info?["CFBundleShortVersionString"] as? String == r.version else {
                    return fail("The downloaded file wasn't the SlideMate \(r.version) app.")
                }
                DispatchQueue.main.async { self.relaunch(replacing: dest, with: app) }
            }.resume()
        }
    }

    /// Quits, then a detached shell script waits for this app (and its server) to exit, swaps the new
    /// bundle in (restoring the old one if that fails) and opens it.
    func relaunch(replacing dest: URL, with app: URL) {
        let q = { (s: String) in "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }
        let pids = [ProcessInfo.processInfo.processIdentifier] + (server.map { [$0.processIdentifier] } ?? [])
        let script = """
        for p in \(pids.map(String.init).joined(separator: " ")); do while kill -0 $p 2>/dev/null; do sleep 0.2; done; done
        D=\(q(dest.path)); N=\(q(app.path))
        xattr -dr com.apple.quarantine "$N" 2>/dev/null
        rm -rf "$D.old" && mv "$D" "$D.old" && if mv "$N" "$D"; then rm -rf "$D.old"; else mv "$D.old" "$D"; fi
        /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$D" 2>/dev/null
        open "$D"
        """
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/sh")
        p.arguments = ["-c", script]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { window.title = "SlideMate"; return updateAlert("The update didn't install", "\(error)") }
        quitConfirmed = true  // we checked there's no recording
        NSApp.terminate(nil)
    }

    // MARK: menus

    @objc func openSettings() { web.evaluateJavaScript("document.querySelector('#btnSettings')?.click()") }
    @objc func reloadPage() {
        guard ready else { return }
        // Reloading the page ends a recording (it lives in the page), so ask first, like quitting.
        confirmIfRecording(action: "reload", proceed: { [weak self] in self?.quitConfirmed = false; self?.web.reload() }, cancel: {})
    }

    func buildMenu() {
        let main = NSMenu()
        func item(_ title: String, _ sel: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) -> NSMenuItem {
            let i = NSMenuItem(title: title, action: sel, keyEquivalent: key)
            i.keyEquivalentModifierMask = mods
            i.target = target
            return i
        }
        let appMenu = NSMenu()
        appMenu.addItem(item("About SlideMate", #selector(NSApplication.orderFrontStandardAboutPanel(_:)), ""))
        appMenu.addItem(item("Check for Updates…", #selector(checkForUpdatesMenu), target: self))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Settings…", #selector(openSettings), ",", target: self))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Hide SlideMate", #selector(NSApplication.hide(_:)), "h"))
        appMenu.addItem(item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]))
        appMenu.addItem(.separator())
        appMenu.addItem(item("Quit SlideMate", #selector(NSApplication.terminate(_:)), "q"))
        let edit = NSMenu(title: "Edit")
        edit.addItem(item("Undo", Selector(("undo:")), "z"))
        edit.addItem(item("Redo", Selector(("redo:")), "z", [.command, .shift]))
        edit.addItem(.separator())
        edit.addItem(item("Cut", #selector(NSText.cut(_:)), "x"))
        edit.addItem(item("Copy", #selector(NSText.copy(_:)), "c"))
        edit.addItem(item("Paste", #selector(NSText.paste(_:)), "v"))
        edit.addItem(item("Select All", #selector(NSText.selectAll(_:)), "a"))
        let view = NSMenu(title: "View")
        view.addItem(item("Reload", #selector(reloadPage), "r", target: self))
        view.addItem(item("Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control]))
        let win = NSMenu(title: "Window")
        win.addItem(item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"))
        win.addItem(item("Zoom", #selector(NSWindow.performZoom(_:)), ""))
        for (title, menu) in [("SlideMate", appMenu), ("Edit", edit), ("View", view), ("Window", win)] {
            let top = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            top.submenu = menu
            main.addItem(top)
        }
        NSApp.mainMenu = main
        NSApp.windowsMenu = win
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.activate(ignoringOtherApps: true)
app.run()
