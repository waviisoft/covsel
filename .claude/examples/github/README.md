# GitHub template examples

Reference copies of the issue and PR templates from the public
[andyvanosdale/agents](https://github.com/andyvanosdale/agents) library. They
encode the conventions the subagents in [`../../agents`](../../agents) follow —
the living-plan issue, the defect record, and the titleless-summary PR — in
their most generic form.

**These are examples, not live config.** GitHub only reads templates from a
repo's `.github/` directory, so nothing here is active. covsel's live templates
under [`.github/`](../../../.github) already apply these conventions, adapted to
this repo (YAML issue forms, a changeset-aware PR checklist, the fail-open
guarantee). Browse these when you want the plain, project-neutral version to
copy into another repo or to see the convention stripped of covsel specifics.

| File                        | Live covsel equivalent                  |
| --------------------------- | --------------------------------------- |
| `pull_request_template.md`  | `.github/pull_request_template.md`      |
| `ISSUE_TEMPLATE/plan.md`    | `.github/ISSUE_TEMPLATE/plan.yml`       |
| `ISSUE_TEMPLATE/bug.md`     | `.github/ISSUE_TEMPLATE/bug_report.yml` |
| `ISSUE_TEMPLATE/config.yml` | `.github/ISSUE_TEMPLATE/config.yml`     |
