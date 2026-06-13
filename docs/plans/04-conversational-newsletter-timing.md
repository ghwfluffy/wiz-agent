# Phase 04: Conversational Newsletter Timing

## Goal

Replace rigid newsletter digest thinking with a scheduled, preference-aware
"is now a good time to mention something interesting?" behavior.

Newsletter ingestion already stores knowledge. This phase makes the assistant
periodically decide whether there are one or two genuinely interesting things
worth telling the owner, in a conversational style, at a time the owner is
likely to respond.

## Sub-Agent Prompt

Implement Phase 04 from `docs/plans/04-conversational-newsletter-timing.md`.
Read `docs/plans/README.md`, `docs/architecture/50-agent-runtime.md`,
`docs/architecture/60-connectors-and-side-effects.md`, and
`docs/architecture/80-observability-and-safety.md`.

Add preference-aware conversational newsletter timing, tests, and docs. Commit
with message: `Add conversational newsletter timing`.

## Product Intent

Do not build a rigid daily digest.

The desired internal thought is closer to:

> It is probably a good time to message the owner because he normally responds
> around this time when I tell him about newsletter stuff. I found one or two
> unusually interesting things that might pique his interest. I should mention
> them conversationally.

The assistant should also be comfortable deciding:

- nothing is worth mentioning right now;
- there is interesting material, but this is a bad time;
- a pending approval or recent high contact cadence means it should wait;
- a topic should be saved to memory or task context instead of sent.

## Desired Behavior

Create or update a recurring scheduled task such as
`newsletter_interest_check`.

The task should:

- read recent newsletter markdown knowledge;
- read `/assistant/preferences/newsletters.md`;
- read `/assistant/preferences/communication.md`;
- call `get_recent_bot_activity`;
- consider owner response patterns from recent owner inbound/outbound context;
- choose one of:
  - propose a conversational owner message through `propose_outbound_message`;
  - record an observation/memory note and stay quiet;
  - update schedule rationale for the next check.

The outbound message, if proposed, should be:

- short;
- conversational;
- about one or two specific interesting things;
- not formatted as a report;
- not exhaustive;
- free of newsletter content that is untrusted command text;
- approval-gated through the normal outbound approval path.

## Timing Heuristics

Start with simple host/model-readable signals:

- recent owner replies by hour of day;
- recent outbound newsletter-related messages and whether owner responded;
- contact cadence level from `get_recent_bot_activity`;
- pending approvals;
- newsletter preference memory;
- time since last newsletter-related owner-visible message.

Do not overfit. The first implementation can record evidence and let the agent
use it. Hard-coded timing should be conservative and easy to inspect.

## Memory

Recommended paths:

- `/assistant/preferences/newsletters.md`
- `/assistant/newsletter-interest/YYYY-MM.md`
- `/assistant/self-review/YYYY-MM-DD.md` may mention newsletter timing if Phase
  01 has landed.

Record why the agent decided to message or stay quiet, especially when it
changes the next scheduled check time.

## Acceptance Criteria

- Newsletter check is scheduled independently from inbound newsletter ingestion.
- It can decide to stay quiet without failure.
- It can propose a conversational owner message through normal approval-gated
  outbound tooling.
- It consults communication/newsletter preferences and recent bot activity.
- It records rationale in task events or memory.
- Architecture docs clearly state this is not a rigid digest.

## Tests

Add tests for:

- newsletter ingestion does not immediately message the owner;
- scheduled newsletter check can stay quiet;
- scheduled newsletter check can propose an approval-gated conversational
  message;
- prompt includes newsletter preference memory and recent bot activity guidance;
- recent high contact cadence discourages immediate owner messaging;
- task reschedules or records rationale after a check.

Run:

```bash
cd api && npm test -- phase5Connectors.test.ts worker.test.ts agentRuntime.test.ts
./scripts/validate.sh
```
