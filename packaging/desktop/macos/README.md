# macOS desktop packaging

The macOS release flow is not implemented yet. Keep it independent from the Windows NSIS build under `packaging/desktop/windows/`.

Planned native deliverables are a signed `.app` inside a `.dmg` and/or `.pkg`, with separate arm64 and x64 validation, Developer ID signing, notarization, first-launch checks, upgrade behavior, and user-data-preserving uninstall guidance.
