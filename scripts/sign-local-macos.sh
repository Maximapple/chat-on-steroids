#!/usr/bin/env bash
#
# Re-sign an installed Chat On Steroids with a stable local identity, so macOS keeps its
# Accessibility and Screen Recording grants across updates.
#
# The published build is deliberately unsigned and its afterPack step seals it ad-hoc
# (`codesign --sign -`). An ad-hoc signature carries no identity, so its designated
# requirement is the cdhash of these exact binaries — every new build is a different cdhash,
# which TCC reads as a different application, and the grants start over. Signing with one
# certificate you keep gives a requirement that names the certificate instead, and that
# survives a replacement.
#
# One-time setup, in Keychain Access:
#   Certificate Assistant > Create a Certificate…
#     Name:              anything, e.g. Chat On Steroids Local Signing
#     Identity Type:     Self Signed Root
#     Certificate Type:  Code Signing
#
# Then, after each update:
#   scripts/sign-local-macos.sh "Chat On Steroids Local Signing"
#
# Gatekeeper still will not vouch for the app — it did not before either. This changes only
# whether macOS recognises the new copy as the same application it already trusts.
set -euo pipefail

identity="${1:-}"
app="${2:-/Applications/Chat On Steroids.app}"

if [ -z "$identity" ]; then
  echo "usage: $0 <certificate-name> [app-path]" >&2
  echo "" >&2
  echo "Certificates available for signing on this machine:" >&2
  security find-identity -v -p codesigning || true
  exit 2
fi

if [ ! -d "$app" ]; then
  echo "No app bundle at: $app" >&2
  echo "Pass its path as the second argument if it lives somewhere else." >&2
  exit 1
fi

if ! security find-identity -v -p codesigning | grep -Fq "$identity"; then
  echo "No code-signing identity named \"$identity\" in your keychain." >&2
  echo "Create one in Keychain Access (see the header of this script), or pick from:" >&2
  security find-identity -v -p codesigning || true
  exit 1
fi

before="$(codesign --display --verbose=2 "$app" 2>&1 | grep -i '^Signature\|^Authority' || echo 'Signature=adhoc (or none)')"

# --deep because the bundle carries its own helpers and native payloads, and a signature that
# stops at the outer bundle leaves them claiming a seal it no longer matches.
codesign --force --deep --sign "$identity" "$app"
codesign --verify --deep --strict --verbose=2 "$app"

echo ""
echo "Signed: $app"
echo "  before: $before"
echo "  now:    $(codesign --display --verbose=2 "$app" 2>&1 | grep -i '^Authority' | head -1)"
echo ""
echo "Grant Accessibility and Screen Recording once more in System Settings > Privacy & Security."
echo "From the next update on they should stay, as long as you sign with this same certificate."
