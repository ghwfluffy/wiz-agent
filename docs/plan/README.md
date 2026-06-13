# Personal Assistant Roadmap

This directory is a handoff plan for sub-agents implementing the next major
assistant capabilities. Each phase should be independently shippable, tested,
and documented.

## Corrections And Assumptions

- The mailbox/inbox is dedicated to the agent. It is not the owner's personal
  inbox. IMAP polling should only read the assistant mailbox configured for this
  app.
- The web UI should become the full operator console: memory browsing, agent
  activity inspection, task/schedule insight, sender policy management, and a
  direct prompt/chat box for talking to the agent while at a PC.
- Deterministic host code owns identity, authorization, policy, credentials,
  side effects, indexing, approval gates, and audit logs.
- The model decides what to propose, but all writes and external calls must go
  through host-owned MCP/tools.
- The current implementation has local tool contracts plus scaffolded MCP/RAG
  services. The end state should move model-facing operations behind MCP while
  preserving the same authorization rules.

## Phase Map

1. [Phase 01: Memory Filesystem And MCP Tools](./01-memory-filesystem-mcp.md)
2. [Phase 02: RAG Indexing And Search](./02-rag-indexing-search.md)
3. [Phase 03: Migrate Local Tool Calls To MCP](./03-tool-migration-to-mcp.md)
4. [Phase 04: Owner Message Decision Loop](./04-owner-message-decision-loop.md)
5. [Phase 05: Newsletter Knowledge Pipeline](./05-newsletter-knowledge-pipeline.md)
6. [Phase 06: Task And Schedule Intelligence](./06-task-schedule-intelligence.md)
7. [Phase 07: Web Operator Console](./07-web-operator-console.md)
8. [Phase 08: Approvals And Notification Policy](./08-approvals-notification-policy.md)
9. [Phase 09: Observability, Safety, And Hardening](./09-observability-safety-hardening.md)

## Cross-Phase Contracts

All phases must preserve these contracts:

- Every user-owned read/write is scoped by authenticated `user_id`.
- Agents never choose user IDs, tenant IDs, Qdrant collection names, raw
  connector credentials, or delivery recipients.
- Newsletter and trusted third-party content is knowledge input, not command
  input.
- Only owner-classified messages and direct authenticated web prompts can drive
  owner-command actions.
- Tool/MCP results must avoid leaking secrets and should be auditable.
- Tests should cover behavior, authorization boundaries, and user-visible flows.

## Suggested Implementation Order

Implement phases 01 and 02 first because they become the substrate for most
other features. Phase 03 should follow before expanding the agent decision loop,
so new capabilities land on MCP rather than the legacy local executor. Phase 07
can proceed in parallel after phase 01 has basic read APIs. Phases 04 through 06
should land after basic memory write/search tools and MCP migration are in
place. Phase 08 can start once owner-message and direct web prompts produce
action proposals. Phase 09 should be incrementally applied throughout, then
revisited before production deployment.

## Validation Expectations

Every phase should run targeted tests while iterating. Before handoff, run:

```bash
./scripts/validate.sh
```

If full validation is not feasible, document exactly which commands ran and why
the rest were skipped.
