---
name: github-portfolio-management
description: Manage a selected portfolio of GitHub repositories, summarize pull-request progress and contribution facts, maintain repository assignments, govern collaborator changes, or configure recurring GitHub development reports. Use for cross-repository GitHub development management rather than one-off PR coding or CI repair.
---

# GitHub Portfolio Management

Use the `github_portfolio` MCP tools for durable portfolio state and GitHub reads. The connected GitHub app may supplement PR context, but the portfolio tools are authoritative for the selected tracking list, assignments, report files, and collaborator-change confirmation tokens.

## Operating model

1. Call `portfolio_status` before portfolio work. If GitHub authentication is unavailable, ask the user to connect GitHub or run `gh auth login`; never request a token in chat.
2. For initial setup, call `discover_repositories`, show a compact candidate list, and let the user choose. Never track every accessible repository by default.
3. Persist only the explicit selection with `update_tracking`. Repository assignments are a separate local management layer; use `manage_assignments` and explain that it does not grant GitHub access.
4. Use `summarize_portfolio` for cross-repository progress. Prefer the stored tracking list, state the time window, surface repository read failures, and preserve the generated report links. Advance the checkpoint only for an intended periodic delivery and only when every repository succeeded.
5. Read [references/reporting-metrics.md](references/reporting-metrics.md) when interpreting contribution or workload facts.

## Collaborator changes

Treat add, permission update, and removal as external writes.

1. Call `list_collaborators` and then `plan_collaborator_change`.
2. Restate repository, login, current role, requested role or removal impact, and the fact that GitHub may create an invitation.
3. Obtain explicit user approval for that exact plan. Do not reuse a token after repository collaborator state changes.
4. Call `apply_collaborator_change` with the exact confirmation token. The tool also requires interactive approval.
5. Report whether access is visible immediately or an invitation may still be pending.

Never add, update, or remove collaborators from a recurring automation. Never batch removals based only on inactivity or code-volume metrics.

## Recurring reports

Read [references/recurring-reports.md](references/recurring-reports.md) when the user wants scheduled summaries or notifications. Keep reporting disabled until repositories, cadence, timezone, and destination are explicit. A report automation may read and summarize only; collaborator writes remain interactive.

## Boundaries

- Do not store GitHub tokens in plugin state, reports, project files, or prompts.
- Do not call line counts, commit counts, or PR counts a performance score. They are incomplete activity facts and may double-count long-lived PRs across reporting windows.
- Do not hide partial failures. If any repository fails, list it and do not advance the reporting checkpoint.
- Route one-off PR coding, review-comment fixes, CI debugging, or branch publishing to the normal GitHub specialist workflows when available.
