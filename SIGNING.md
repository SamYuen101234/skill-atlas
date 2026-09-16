# Signing and notarizing the Mac app

One-time setup, then `npm run dist` produces a signed, notarized, stapled `.dmg`.

## 1. Apple Developer Program
Enroll at https://developer.apple.com/programs/ (US$99/year). Note your **Team ID**
(Membership details page, 10 characters).

A free Apple ID is not enough: it only issues *Apple Development* certificates, which
macOS rejects on other people's machines. **Developer ID Application** — the one that lets
a `.dmg` open by double-click anywhere — requires the paid program.

## 2. Developer ID Application certificate (on the Mac that builds)

**With Xcode** (easiest): Xcode → Settings → Accounts → select your Apple ID →
Manage Certificates → **+** → **Developer ID Application**. It lands in your login keychain.

**Without Xcode:**

1. Keychain Access → menu **Certificate Assistant → Request a Certificate From a Certificate
   Authority**. Enter your Apple ID email and name, choose **Saved to disk** + **Let me specify
   key pair information**, and save `CertificateSigningRequest.certSigningRequest`
   (key pair: 2048 bits, RSA).
2. https://developer.apple.com/account/resources/certificates/add → **Developer ID Application**
   → upload the CSR → download `developerID_application.cer`.
3. Double-click the `.cer` to install it into the login keychain.

Either way, check it landed:

```bash
security find-identity -v -p codesigning
# expect: "Developer ID Application: Your Name (TEAMID)"
```

electron-builder picks this identity up automatically. Nothing to configure.

## 3. Notarization credentials
Either an App Store Connect API key (preferred for CI) or your Apple ID with an
app-specific password (https://appleid.apple.com → Sign-In and Security → App-Specific Passwords).
Put them in your shell, never in the repo:

```bash
# Apple ID route
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="TEAMID"

# or API key route
export APPLE_API_KEY="/path/to/AuthKey_KEYID.p8"
export APPLE_API_KEY_ID="KEYID"
export APPLE_API_ISSUER="issuer-uuid"
```

`package.json` already sets `mac.notarize: true`, the hardened runtime and the
entitlements Electron needs, so:

```bash
npm run dist
```

signs the app, uploads it to Apple's notary service (a few minutes), staples the ticket
and writes `release/Skill Atlas-<version>-<arch>.dmg`. Without the variables the build
still succeeds but logs "skipped notarization".

## 4. Verify
```bash
codesign -dv --verbose=2 "release/mac-arm64/Skill Atlas.app"
spctl -a -vv "release/mac-arm64/Skill Atlas.app"     # should say "accepted, source=Notarized Developer ID"
xcrun stapler validate "release/mac-arm64/Skill Atlas.app"
```

## 5. CI (GitHub Actions)

`.github/workflows/release.yml` already reads these secrets and skips signing when they are absent.
Export the certificate from Keychain Access as a `.p12` with a password, base64 it, and
store it as a secret with the password and the notarization variables above:

```bash
base64 -i DeveloperID.p12 | pbcopy   # → secret CSC_LINK
```

electron-builder reads `CSC_LINK` and `CSC_KEY_PASSWORD` directly. A `macos-latest`
runner with `npm ci && npm run dist` then produces release artifacts you can attach to
a GitHub Release and point a Homebrew cask at.
