# Domain Model

The durable model is multi-tenant even while standalone mode uses one tenant and
one user.

## Core Entities

- Tenant: isolation boundary for users, tasks, memory, messages, connectors, and
  agent runs.
- User: local representation of a signed-in person.
- Tenant membership: user role within a tenant.
- Session: server-side session tied to a user and tenant context.
- Connector: configured external integration such as IMAP or SMTP.
- Conversation: grouped messages and agent interactions.
- Message: inbound, outbound, or internal communication.
- Task: scheduled or on-demand work item for the agent or worker.
- Task event: append-only task state transition history.
- Approval: user/admin decision required before a high-risk side effect.
- Memory document: user-visible long-term memory.
- Memory revision: proposed or accepted memory change.
- Outbound message: queued email, SMS, or MMS side effect.
- Link/article snapshot: fetched content under safe-fetch policy.
- Agent run: one bounded model invocation or task execution.
- Tool call: model-proposed action and deterministic host outcome.
- Audit log: durable record of meaningful writes and privileged actions.
- AI backend config: admin-managed model tiers and budgets.

## Ownership Rule

Tenant-scoped tables must include `tenant_id`. User-owned records usually also
include `user_id`. Services should accept explicit tenant/user context rather
than deriving scope deep in database helpers.

## Source And Derived State

Source records such as messages, tasks, approvals, memory revisions, tool calls,
and audit logs should be preserved. Summaries, dashboards, and cached activity
views should be rebuildable from source records where practical.
