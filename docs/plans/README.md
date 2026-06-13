# Personal Assistant Improvement Plan

This directory contains implementation handoffs for the next assistant
capabilities. Each phase is intended for one sub-agent to implement, commit,
and hand back for review.

## Direction

The assistant should become more self-aware and less reactive without becoming
noisy. It should periodically inspect its own recent behavior, remember durable
preferences and task outcomes, execute approved side effects safely, and decide
when conversational newsletter discoveries are worth mentioning.

Important product intent:

- Newsletter output is not a rigid daily digest. The agent should periodically
  think about whether now is a good time to tell the owner one or two genuinely
  interesting things it learned, in a conversational style.
- Rate and budget controls are safety rails. Their primary purpose is to stop
  accidental loops, runaway token use, SMTP provider abuse, and repeated
  owner-contact attempts. Exact defaults matter less than fail-closed bounded
  behavior and operator visibility.
- Preferences about contact timing, interruption threshold, tone, and newsletter
  interest should live in long-term markdown memory, not in hard-coded prompts.
- Personal memory offload use cases such as movies to watch, project ideas,
  gift ideas, restaurants, and research topics need structured list semantics
  even though markdown remains the storage substrate.
- Host code owns policy, limits, approvals, credentials, delivery recipients,
  audit logs, and cross-app execution. The model proposes actions through MCP.

## Phase Order

1. [Self Review And Preference Memory](./01-self-review-preference-memory.md)
2. [Approved Cross-App Write Executor](./02-cross-app-approval-executor.md)
3. [Task Outcome Memory](./03-task-outcome-memory.md)
4. [Conversational Newsletter Timing](./04-conversational-newsletter-timing.md)
5. [Runaway Loop Guardrails](./05-runaway-loop-guardrails.md)
6. [Personal Memory Lists](./06-personal-memory-lists.md)

## Cross-Phase Contracts

- Do not read or expose files under `secrets/`.
- Do not add local password auth.
- Do not put production hostnames, production paths, redirect URIs, or deploy
  secrets in this submodule.
- Do not let newsletter, trusted third-party, or untrusted sender content trigger
  owner-command actions.
- Do not let the model choose user IDs, Qdrant collection names, raw delivery
  recipients, connector credentials, approval IDs, or cross-app bearer tokens.
- Keep `api/src/integrations/capabilityRegistry.ts` current when cross-app
  capability behavior changes.
- Update architecture docs in `docs/architecture/` for durable behavior.
- Add tests for behavior changes.
- Run focused tests while iterating and `./scripts/validate.sh` before handoff
  when feasible.

## Suggested Main-Agent Review Loop

For each phase:

1. Spawn one worker sub-agent with this README and the phase document.
2. Tell the worker to implement, test, document, and commit the phase.
3. Review the commit in code-review mode.
4. Fix issues directly if needed.
5. Amend the worker's commit with review fixes.
6. Move to the next phase only after validation passes or the skipped
   validation is clearly explained.

After all phases, perform one whole-changeset review. If fixes are needed, make
a final CR commit.
