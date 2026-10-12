# Windows Desktop Release

The first desktop candidate targets Windows x64. The supported minimum is Windows 11 25H2 (build 26200) or Windows Server 2025 (build 26100). Installs are per user; no administrator rights are needed. Candidates are unsigned and updates are manual.

## Build a candidate

Use the exact Bun version declared in `package.json` and install the lockfile dependencies first:

```powershell
bun --version
bun install --frozen-lockfile
bun run desktop:release:windows
```

The release command requires Bun 1.3.14 and x64. It checks TypeScript, runs `bun run test`, cross-compiles the CLI/TUI for Windows x64, builds the Electron renderer and backend bundle, and packages the locked Bun Windows runtime, Electron runtime, Windows keyring binding, and PortableGit. Downloads are cached under ignored `dist/toolchain/desktop-windows-x64/` and checked against their locked SHA-256 values. The release ZIP and `.sha256` sidecar are written under `dist/releases/`.

The command runs the packaged backend on Windows with an isolated profile and a temporary Git project. It checks the protocol/version handshake, project session, no-credential model setup error, bundled Git review diff, Git Bash terminal, credential-sentinel logs, and backend shutdown. It then installs, upgrades, and uninstalls into a temporary profile whose path contains spaces and checks user-data preservation. The archive verifier checks every file against the manifest and checks the archive checksum. A failed gate stops candidate creation.

The release manifest records the package version, source commit and tree digest, dirty-source flag, target OS, Bun/Electron/Git versions, protocol versions, runtime/license checksums, and validation results. Bun's upstream license notice is included as `resources/BUN-LICENSE.md`. Builds from a dirty tree remain marked dirty and are not release-ready.

## Install, upgrade, and uninstall

Extract the ZIP, then run `Install-Microcode.ps1` from the extracted folder:

```powershell
Expand-Archive .\microcode-desktop-v0.1.0-windows-x64.zip .\Microcode-Release
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Microcode-Release\Install-Microcode.ps1
```

The installer verifies the manifest and every listed file before copying the full Electron application to `%LOCALAPPDATA%\Programs\Microcode`. It creates a Start Menu shortcut and a per-user uninstall entry. It bundles Electron, the locked Bun runtime and backend bundle, Git for Windows, and Git Bash; the installed app does not require a separately installed Bun, Node.js, Git, or WSL.

To upgrade, close Microcode and run the new release's installer. It replaces the app directory but leaves user data in place. To uninstall from PowerShell, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\Microcode\Uninstall-Microcode.ps1"
```

Uninstall removes the application, Start Menu shortcut, and uninstall registry entry. It preserves sessions, settings, logs, project files, and Windows Credential Manager credentials.

## Data and troubleshooting

- Sessions, project configuration, and Microcode CLI/runtime data: `%USERPROFILE%\.microcode\`
- Desktop recent-project metadata and Electron logs: `%APPDATA%\Microcode\`
- Provider credentials saved by the app: Windows Credential Manager. Existing provider environment variables remain under the user's control and are not copied into the package.
- Version/protocol mismatch: close Microcode and rerun the installer from one complete release ZIP so the Electron app and backend come from the same manifest.
- Missing provider credentials: open Desktop Settings and sign in or configure the provider's existing environment settings. The release smoke makes no model request and never puts a live credential in the package.
- Backend or terminal startup error: inspect `%APPDATA%\Microcode\logs\` and verify the package was extracted completely. Packaged Git Bash is under the install directory's `resources\git\`.
- Windows SmartScreen may warn because candidates are unsigned. There is no automatic updater, TLS service, per-client identity, or update feed in this desktop package.

## Manual acceptance on a clean Windows x64 profile

Use Windows 11 25H2 or Windows Server 2025, with no development tooling installed. Expand and install the ZIP using the steps above, then run:

```powershell
Start-Process "$env:LOCALAPPDATA\Programs\Microcode\Microcode.exe"
```

Open a Git project, configure a model provider, send a prompt that requires a file edit, approve the requested tool action, confirm the edited file appears in the right-side review panel, and run a harmless command in the bottom terminal. Close the app and verify `Get-Process Microcode,microcode-backend -ErrorAction SilentlyContinue` returns no processes. Run the next package's installer over the existing install and confirm the project/session and settings remain available. Finally run the uninstaller and confirm those data directories and credentials remain.

This is a human UI gate: an unattended backend smoke cannot prove the rendered conversation, approval controls, or final visual match to a supplied desktop screenshot. Attach the approved Codex Desktop reference screenshot to the acceptance record if visual comparison is required.
