---
name: skill-creator
description: Create a reusable Microcode Skill in the correct user or project scope.
---

# Create a Microcode Skill

Create a file-backed Skill using the `SKILL.md` format. First read the current `<env>` facts and identify the operating system and shell this Microcode process actually runs under. Path syntax and shell commands must match that platform; do not assume Linux, POSIX paths, or Unix commands. Use the reported platform-native **Microcode home** path for user-wide files and the reported working directory for project files. If those facts are unavailable, determine the OS before constructing a filesystem path. Ask only for details that are needed to produce a useful, focused capability. Use a short lowercase kebab-case directory and matching `name`, and write a concise `description` that says when the Skill applies.

## Scope and destination

- If the user does not specify a scope, create a user Skill under the Microcode home directory, in its `skills/<name>/` subdirectories, with `SKILL.md` as its entry file. Construct the path using the host OS's path rules; do not type a Unix-style home shortcut as a literal path.
- If the user asks for a Skill for the current repository or project, create it under the working directory's `.microcode/skills/<name>/` subdirectories, using native path separators.
- Never create ordinary Skills under the Microcode home `skills/.system/` subdirectories. That tree is owned and rebuilt by Microcode.
- Do not overwrite an existing Skill without first inspecting it and preserving its useful content.

Keep the instructions specific to the requested workflow. Do not include secrets or claim tools/integrations that Microcode does not expose. Supporting scripts or references may live beside `SKILL.md` when the task needs them. Prefer cross-platform script runtimes and path handling; if a helper only works on some operating systems, state the supported platforms and provide the appropriate platform-specific invocation.
