# Windows Desktop Release

The Windows x64 release produces one deliverable: a branded Setup wizard, plus its SHA-256 checksum file. The supported minimum is Windows 11 25H2 (build 26200) or Windows Server 2025 (build 26100). Setup installs for the current user and does not ask for administrator rights.

## Build a candidate

Run from the repository root with the project-pinned Bun 1.3.14 on an x64 Windows host or WSL attached to Windows:

```powershell
bun --version
bun install --frozen-lockfile
bun run desktop:release:windows
```

The build downloads and verifies the locked Electron, Bun, PortableGit, and NSIS 3.13 toolchain into ignored `dist/toolchain/desktop-windows-x64/`. It does not install or modify Bun on the machine. The build checks TypeScript, runs `bun run test`, cross-compiles the CLI/TUI, packages the desktop app, smoke-tests the bundled backend, then runs the actual Setup wizard in silent mode through a selected directory, upgrade, and uninstall. It verifies that the Start Menu entry, Windows uninstall registration, and user data behave as expected. A failed gate stops release output creation. Temporary candidate and validation directories are removed after success or failure; the verified toolchain cache is retained for later builds.

The release command writes a versioned `*-setup.exe` and its `.sha256` sidecar under `dist/releases/`. Release outputs are never overwritten.

## Install and upgrade

Double-click `*-setup.exe` and follow the Windows wizard. It displays Microcode branding, lets the user choose an installation directory, offers an optional Desktop shortcut, creates a Start Menu group and an Apps/Installed apps uninstall entry, and offers to launch Microcode after setup. Setup remembers the selected location so later releases upgrade in place. To move an existing installation, uninstall it first and then install the new release at the desired location.

The app includes Electron, the locked Bun runtime and backend bundle, Git for Windows, and Git Bash. It does not require a separately installed Bun, Node.js, Git, or WSL. Sessions, settings, logs, project files, and Windows Credential Manager credentials are stored outside the application directory and are preserved when uninstalling.

To uninstall, use **Settings → Apps → Installed apps → Microcode** or the Start Menu's **Uninstall Microcode** shortcut.

## Release readiness

The Windows build produces an unsigned candidate because no product signing certificate is configured. Windows SmartScreen may warn on first launch. Updates are manual. Before publishing a public release, sign the app binaries, setup executable, and uninstaller with the product publisher certificate, then complete the clean-profile UI acceptance below.

## Clean-profile acceptance

On a clean supported Windows x64 profile, double-click Setup, choose a non-default directory, verify the optional Desktop shortcut setting and Start Menu entry, launch Microcode from the Finish page and the Start Menu, open a project, configure a provider, and verify a prompt and terminal session. Run the same Setup over the install and confirm sessions and settings remain. Uninstall from Windows Settings and verify the app files are removed while user data remains.
