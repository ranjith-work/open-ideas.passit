// Loads a page in WKWebView and prints the text of one element.
//
// Used by the browser tests: this machine's policy blocks every bind(), which
// rules out both a local HTTP server and headless Chrome (it needs a singleton
// socket). WKWebView needs neither, and it exercises WebKit — the engine on
// the phone that will usually be receiving the handoff.
//
// Usage: swift run-page.swift <file-url> <css-selector> <read-access-root> [settle-ms]

import Cocoa
import WebKit

let arguments = CommandLine.arguments
guard arguments.count >= 4, let url = URL(string: arguments[1]) else {
    FileHandle.standardError.write("usage: run-page.swift <url> <css-selector> <root> [settleMs]\n".data(using: .utf8)!)
    exit(2)
}
let selector = arguments[2]
let readRoot = URL(fileURLWithPath: arguments[3], isDirectory: true)
let settleMs = arguments.count > 4 ? Int(arguments[4]) ?? 1500 : 1500

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let configuration = WKWebViewConfiguration()
// Module scripts on a file: origin are cross-origin to each other without
// this; it is the same allowance Chrome spells --allow-file-access-from-files.
configuration.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
configuration.setValue(true, forKey: "allowUniversalAccessFromFileURLs")

let webView = WKWebView(
    frame: NSRect(x: 0, y: 0, width: 1200, height: 900),
    configuration: configuration
)

final class Delegate: NSObject, WKNavigationDelegate {
    var finished = false
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) { finished = true }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("navigation failed: \(error)\n".data(using: .utf8)!)
        exit(3)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        FileHandle.standardError.write("navigation failed: \(error)\n".data(using: .utf8)!)
        exit(3)
    }
}

let delegate = Delegate()
webView.navigationDelegate = delegate

// A window is not shown, but the view needs to be in one to lay out properly —
// getBoundingClientRect and elementFromPoint are the whole point of using a
// real engine.
let window = NSWindow(
    contentRect: webView.frame,
    styleMask: [.titled],
    backing: .buffered,
    defer: false
)
window.contentView = webView
window.orderBack(nil)

// `loadFileURL` refuses query strings, so load the directory and then navigate
// to the full URL from inside the same origin.
webView.loadFileURL(readRoot.appendingPathComponent("test/fixtures/blank.html"), allowingReadAccessTo: readRoot)

var stage = 0
let deadline = Date().addingTimeInterval(30)

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("\(message)\n".data(using: .utf8)!)
    exit(4)
}

/// Poll until the target has content. A fixed sleep would either be flaky on
/// a slow capture or waste seconds on a fast one.
///
/// A selector beginning `js:` evaluates the rest as an expression instead,
/// which is how the tests inspect state that is not rendered anywhere.
func pollForContent() {
    if Date() > deadline { fail("timed out waiting for \(selector)") }
    let script = selector.hasPrefix("js:")
        ? "String(\(String(selector.dropFirst(3))))"
        : "document.querySelector(\(jsString(selector)))?.textContent ?? ''"
    webView.evaluateJavaScript(script) { value, error in
        if let error { fail("evaluate failed: \(error)") }
        let text = (value as? String) ?? ""
        if text.isEmpty {
            DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(100), execute: pollForContent)
        } else {
            print(text)
            exit(0)
        }
    }
}

func pump() {
    if Date() > deadline { fail("timed out loading the page") }

    switch stage {
    case 0 where delegate.finished:
        stage = 1
        delegate.finished = false
        webView.evaluateJavaScript("location.replace(\(jsString(url.absoluteString)))") { _, _ in }
    case 1 where delegate.finished:
        stage = 2
        // `settleMs` is the minimum wait: long enough for the browser to have
        // acted on a fragment directive before anything is read back.
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(settleMs), execute: pollForContent)
    default:
        break
    }

    if stage < 2 {
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(50), execute: pump)
    }
}

func jsString(_ value: String) -> String {
    let data = try! JSONSerialization.data(withJSONObject: [value], options: [])
    let array = String(data: data, encoding: .utf8)!
    return String(array.dropFirst().dropLast())
}

DispatchQueue.main.async(execute: pump)
app.run()
