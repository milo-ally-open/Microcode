# Linux desktop packaging

The Linux release flow is not implemented yet. Keep it independent from the Windows NSIS build under `packaging/desktop/windows/`.

The Linux implementation will define its supported distributions and package formats before adding its own runtime preparation, desktop entry and icon integration, sandbox policy, dependency checks, upgrade behavior, and user-data-preserving uninstall tests.
