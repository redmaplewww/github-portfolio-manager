# Recurring report activation

Before creating a Codex heartbeat automation, confirm all of:

- at least one repository is in the tracked list;
- cadence and local timezone;
- destination, normally the current Codex task;
- whether the first run covers the previous seven days or a custom timestamp.

Store the choice with `configure_reporting`, then create or update one heartbeat automation. The automation prompt should:

- call `portfolio_status` and stop clearly when reporting is disabled;
- call `summarize_portfolio` for the tracked list with `advanceCheckpoint=true`;
- post a concise Chinese summary plus the report path;
- expose repository failures and preserve the old checkpoint on partial failure;
- never call `plan_collaborator_change` or `apply_collaborator_change`;
- never infer a performance ranking from code-volume fields.

If the user has not supplied a cadence, suggest Monday 09:00 in `Asia/Shanghai`, but do not activate it until they accept that schedule.
