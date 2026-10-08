// SlideMate for macOS: a native window around the local SlideMate server.
//
// On launch it starts `server/server.py` (bundled in Contents/Resources) with the system Python 3,
// waits for it to answer, then shows the UI in a WKWebView. Quitting the app stops the server.
import Cocoa
import WebKit

let port = ProcessInfo.processInfo.environment["SLIDEMATE_PORT"] ?? "8767"
let base = URL(string: "http://127.0.0.1:\(port)/")!
let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/SlideMate")

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var pendingFile: String?
    var ready = false

    func applicationDidFinishLaunching(_ note: Notification) {
        buildMenu()
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
        showMessage("Starting SlideMate…")

        startServer { [weak self] ok, detail in
            guard let self = self else { return }
            if ok {
                self.ready = true
                self.load(file: self.pendingFile)
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
        // /usr/bin/python3 is only a stub until the Xcode Command Line Tools are installed.
        let cltInstalled = FileManager.default.fileExists(atPath: "/Library/Developer/CommandLineTools/usr/bin/python3")
            || FileManager.default.fileExists(atPath: "/Applications/Xcode.app/Contents/Developer/usr/bin/python3")
        let pythons = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3"] + (cltInstalled ? ["/usr/bin/python3"] : [])
        guard let python = pythons.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) else {
            return done(false, "SlideMate needs Python 3, which comes with Apple's free Command Line Tools.\n\n"
                        + "Open Terminal, run:   xcode-select --install\nthen reopen SlideMate.")
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

    func showMessage(_ title: String, detail: String = "") {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let html = """
        <html><body style="font:14px -apple-system;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
        color:#888;background:transparent"><div style="max-width:640px;text-align:center"><p style="font-size:15px;color:#999">\(esc(title))</p>
        <pre style="text-align:left;white-space:pre-wrap;font:11px Menlo;color:#888">\(esc(detail))</pre></div></body></html>
        """
        web.loadHTMLString(html, baseURL: nil)
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

    // Native folder picker for the setup screen: window.webkit.messageHandlers.slidemate.postMessage({action: "pickFolder"})
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], body["action"] as? String == "pickFolder" else { return }
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
