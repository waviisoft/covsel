# Team agent tooling

Project-scoped Claude Code documents shared by everyone who works in covsel.
Because they live under a committed `.claude/`, they apply to any session opened
on this repo — so this directory holds **team-wide** tooling only, never
personal preferences.

Adapted from the public [andyvanosdale/agents](https://github.com/andyvanosdale/agents)
library and tuned for covsel's conventions in [`AGENTS.md`](../AGENTS.md).

## Subagents — `agents/`

| Agent           | Use when                                                                                                                    |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `code-reviewer` | Reviewing a diff, branch, or PR across correctness, security, privacy, principles, and tests.                               |
| `pr-author`     | Taking a change from branch to squash-merged PR, with an independent review first.                                          |
| `project-setup` | Setting up or auditing repo structure so the repo reflects what exists today and every feature is documented under `docs/`. |
| `tdd-engineer`  | Implementing a feature or fixing a bug test-first (red → green → refactor).                                                 |

## Skills — `skills/`

| Skill        | Use when                                                                      |
| ------------ | ----------------------------------------------------------------------------- |
| `pr-summary` | You want a short, reviewer-friendly summary of what a branch changes and why. |

## Note

These documents are **instructions** the model loads into context. Read one
before relying on it, the same way you'd review any code that runs in the repo.
