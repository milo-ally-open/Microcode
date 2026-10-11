# Microcode Packaging

This directory contains CLI/TUI release packaging scripts outside `src/` and
`tests/`.

The scripts are platform-aware and produce native packages for the operating
system they run on:

- Linux: `*-linux-x64.tar.gz` or `*-linux-arm64.tar.gz`
- Windows: `*-windows-x64.zip` or `*-windows-arm64.zip`
- macOS: `*-macos-x64.tar.gz` or `*-macos-arm64.tar.gz`

Build on each target platform to create downloads for Linux, Windows, and
macOS.

## Build and verify the installed command

On Windows, `bun run build` compiles `dist/microcode.exe` and atomically replaces
`%LOCALAPPDATA%\microcode\bin\microcode.exe`. The build verifies that the
installed file matches the compiled artifact. If Windows has the old executable
open, the build fails without claiming that installation succeeded; close every
Microcode process and run `bun run build` again. The failed build removes its
temporary file when Windows permits cleanup.

The build also prints `where.exe microcode` results so you can see which
executables are found through the current PATH and whether an earlier hit can
shadow the canonical installation. `where.exe` cannot see aliases or functions
defined in an already-open PowerShell session. Check the command PowerShell
actually resolves with:

```powershell
Get-Command -All microcode | Format-List CommandType,Name,Source,Definition
```

To verify the installed binary directly, bypass command lookup:

```powershell
& "$env:LOCALAPPDATA\microcode\bin\microcode.exe" --help
```

If another executable appears first, move
`%LOCALAPPDATA%\microcode\bin` before its directory in PATH, or remove the
stale PATH entry yourself. The build does not remove other installations or
change PATH automatically.

## CLI / TUI Package

```sh
bun run package:cli
```

Creates:

- `packaging/out/staging/microcode-cli-v<version>-<platform>-<arch>/`
- `packaging/out/microcode-cli-v<version>-<platform>-<arch>.tar.gz` on Linux/macOS
- `packaging/out/microcode-cli-v<version>-<platform>-<arch>.zip` on Windows

The CLI package contains a standalone `bin/microcode` binary and `install.sh`.
On Windows it also includes `install.cmd`.
