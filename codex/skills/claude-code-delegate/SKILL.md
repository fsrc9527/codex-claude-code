---
name: claude-code-delegate
description: Delegate scoped coding tasks to the visible Claude Code subagent, inspect its tool activity, and follow up in the same Claude Code session.
---

- Pass the requested `effort` for a new task or follow-up. Use `claude_code.models` with `model` to find its supported effort levels.
- When the user requests Claude Code, send `claude_code.run` or `claude_code.follow_up` through the native Codex role `claude_code` so the user can view and stop each turn. Give it one task and acceptance criteria. Specify the absolute project directory for a new task or the prior run ID for a follow-up.
- Pass the requested model for a new task or follow-up. Use `claude_code.models` in the project to find available model names. Omit `model` to use the provider default or keep the session's model.
- Keep tasks read-only by default. Enable `edit=true` only for authorized file changes, name the files, and verify the diff and targeted tests.
- Use `claude_code.trace` to inspect tool activity and find active or recent runs. Use `claude_code.cancel` with the run ID for an explicit stop, then check the saved status and any applied edits.
