---
'covsel': minor
---

Make `covsel init` interactive by definition, and put `--no-install` in the plan
rather than behind it.

`init` writes files and installs packages, so it should do nothing without an
answer — and silence is not one. A run with no terminal previously proceeded and
installed, on the reasoning that running the command is itself the intent. That
is not good enough for something that adds dependencies to a project: in CI or
under a coding agent there is nobody to ask, and installing anyway assumes
consent that was never given. `init` now prints the plan, changes nothing, and
exits non-zero unless `--auto-approve` says otherwise.

`--auto-approve` replaces `-y` / `--yes`. The name is the point: this is not
"answer the prompt", it is "authorise an unattended run to change the project".

`--no-install` now describes a different plan rather than a quieter one. It
previously suppressed the install silently, so the plan being agreed to never
mentioned the adapter the project still needed, and nothing mentioned it
afterwards either. The packages are now listed under `skip` with the command
that installs them, and named again once the config is written.

Declining is unchanged and stays that way: nothing is written and nothing is
installed. Declining the plan and asking for a plan without an install are
different answers, and `--no-install` is how you say the second.
