---
name: plugin-creator
description: Create a local Microcode plugin package with optional Skills and MCP servers.
---

# Create a Microcode plugin

Create a plugin directory with a valid `plugin.json`. First read the current `<env>` facts and identify the operating system and shell this Microcode process actually runs under. Use the reported platform-native Microcode home path for user-wide packages and the reported working directory for project packages. Construct paths with native path rules; never assume Linux, POSIX paths, or Unix commands. If those facts are unavailable, determine the OS before constructing a filesystem path. Place plugin Skills under `skills/<skill-name>/SKILL.md` and optional MCP server declarations in the plugin root `mcp.json`, using the existing Plugin schema. Ensure bundled scripts and MCP commands target the detected OS, or state which operating systems they support. Use the Plugin manager to validate and enable the package; its MCP servers connect automatically while it is enabled.

## Scope and destination

- If the user does not specify a scope, create a user plugin under the Microcode home directory's `plugins/<plugin-name>/` subdirectories.
- If the user asks for a plugin for the current repository or project, create it under the working directory's `.microcode/plugins/<plugin-name>/` subdirectories, using native path separators.
- Never create ordinary capabilities in a `.system/` directory; only Microcode's system installer owns those paths.
- Do not overwrite an existing plugin without inspecting it and preserving unrelated files and settings.

Reuse `skill-creator` guidance for Skill content and `mcp-creator` guidance for MCP config. A plugin is packaging for its components, not a separate Agent or permission mechanism. Explain which components are included and that enabling a plugin starts its configured MCP servers; tool calls still follow normal Microcode permissions.
