# Desktop packaging

Desktop release engineering is split by operating system. Each platform owns its native installer, runtime preparation, signing, and validation flow:

- [Windows](windows/README.md): a branded per-user NSIS setup wizard. Build with `bun run desktop:release:windows`.
- [macOS](macos/README.md): packaging flow is reserved and not implemented yet.
- [Linux](linux/README.md): packaging flow is reserved and not implemented yet.

The Windows implementation does not define or replace the repository's Bun installation. Its release toolchain is pinned separately in `windows/runtime-lock.json`.
