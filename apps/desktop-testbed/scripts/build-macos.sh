#!/bin/sh
# Builds the sign-in form into build/SignInForm.app with the Swift compiler
# from the Xcode command line tools; no Xcode project.
set -eu
cd "$(dirname "$0")/.."
app=build/SignInForm.app
rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
swiftc -O -o "$app/Contents/MacOS/SignInForm" app/macos/main.swift
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>dev.e2e.desktop-testbed.sign-in</string>
  <key>CFBundleName</key><string>SignInForm</string>
  <key>CFBundleExecutable</key><string>SignInForm</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$app"
echo "built $app"
