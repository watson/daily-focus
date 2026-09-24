@AGENTS.md

<!--
This file is a pointer, on purpose. Claude Code reads CLAUDE.md and not AGENTS.md,
so it needs to exist — but every instruction lives in AGENTS.md so that Codex,
Cursor and anything else reading that file get the same rules from the same place.

Both are for changing this repo's code. Neither is read by the agent that writes the
morning brief: its prompt is prompts/morning-brief-work.md (or -personal.md),
installed into the store as a symlink so that it never reads anything in here. See
prompts/README.md before moving either side of that boundary.

An import rather than a symlink: a symlink needs Administrator privileges or
Developer Mode on Windows, where git otherwise checks it out as a plain text file
containing the target path, which fails silently as a file of instructions.

If a genuinely Claude-specific rule ever appears, add it below the import. Anything
that would apply to another coding agent belongs in AGENTS.md instead.
-->
