---
name: mcp-creator
description: Configure a standalone Microcode MCP package in user or project scope.
---

# Create a Microcode MCP package

Create standalone MCP integrations as directories containing `mcp.json`. First read the current `<env>` facts and identify the operating system and shell this Microcode process actually runs under. Use the reported platform-native Microcode home path and native path separators; never assume Linux, POSIX paths, or Unix commands. If those facts are unavailable, determine the OS before constructing a filesystem path. Use the existing Microcode MCP config format: a root `mcpServers` object whose entries use `{ "command": "...", "args": [...] }` for stdio or a supported `{ "type": "...", "url": "..." }` remote transport. One package may contain multiple server entries. For stdio, choose a command that is actually available and launchable on the detected OS; do not assume Unix executables, shell syntax, or script extensions work on Windows, and do not claim cross-platform support unless the configured command and package support it.

## Scope and destination

- If the user does not specify a scope, create a user package under the Microcode home directory, in its `mcp/<package>/` subdirectories, with `mcp.json` as its entry file. Construct the path using the host OS's path rules; do not type a Unix-style home shortcut as a literal path.
- If the user asks to configure the current repository or project, create it under the working directory's `.microcode/mcp/<package>/` subdirectories, using native path separators.
- Never write to the Microcode home `mcp/.system/` subdirectories; that tree is owned and rebuilt by Microcode.
- Do not put new standalone MCP configuration in `config.json`; that format remains only for legacy compatibility.
- Do not overwrite an existing package without inspecting it and preserving unrelated server entries and assets.

Validate the JSON and server config before finishing. Valid standalone MCP configurations connect automatically when discovered, so make sure the user explicitly requested the integration before creating it. Explain that connection does not approve tool calls; normal Microcode permissions still apply. Never include secret values in summaries.
