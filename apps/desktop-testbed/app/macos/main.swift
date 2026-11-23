// The desktop testbed's sign-in form: AppKit controls with accessibility
// identifiers, the same form the agent-desktop spike measured. Sign in
// writes what it read into the status line, so a test can check every
// control reached the app.

import AppKit

final class Controller: NSObject, NSApplicationDelegate {
  var window: NSWindow!
  let username = NSTextField()
  let password = NSSecureTextField()
  let remember = NSButton(checkboxWithTitle: "Remember me", target: nil, action: nil)
  let plan = NSPopUpButton()
  let status = NSTextField(labelWithString: "Not signed in")

  func applicationDidFinishLaunching(_ note: Notification) {
    window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 420, height: 320),
                      styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
    window.title = "Sign In"
    let heading = NSTextField(labelWithString: "Sign in to the testbed")
    heading.font = .boldSystemFont(ofSize: 16)
    username.placeholderString = "Username"
    username.setAccessibilityIdentifier("username")
    username.setAccessibilityLabel("Username")
    password.placeholderString = "Password"
    password.setAccessibilityIdentifier("password")
    password.setAccessibilityLabel("Password")
    remember.setAccessibilityIdentifier("remember")
    plan.addItems(withTitles: ["Free", "Pro", "Team"])
    plan.selectItem(withTitle: "Pro")
    plan.setAccessibilityIdentifier("plan")
    plan.setAccessibilityLabel("Plan")
    status.setAccessibilityIdentifier("status")
    let signIn = NSButton(title: "Sign in", target: self, action: #selector(signIn(_:)))
    signIn.setAccessibilityIdentifier("sign-in")
    let stack = NSStackView(views: [heading, username, password, remember, plan, signIn, status])
    stack.orientation = .vertical
    stack.alignment = .leading
    stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
    username.widthAnchor.constraint(equalToConstant: 260).isActive = true
    password.widthAnchor.constraint(equalToConstant: 260).isActive = true
    status.widthAnchor.constraint(equalToConstant: 360).isActive = true
    window.contentView = stack
    window.makeKeyAndOrderFront(nil)
    NSApp.activate(ignoringOtherApps: true)
  }

  @objc func signIn(_ sender: NSButton) {
    if password.stringValue.isEmpty {
      status.stringValue = "Password is required"
      return
    }
    // The password's length, never the password: a test proves the secret reached the field without the app showing it.
    let remembered = remember.state == .on ? ", remembered" : ""
    status.stringValue = "Signed in as \(username.stringValue) on \(plan.titleOfSelectedItem ?? "?")\(remembered) (password: \(password.stringValue.count) characters)"
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.regular)
app.run()
