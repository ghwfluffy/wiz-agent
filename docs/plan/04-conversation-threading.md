# Phase 04: Conversation Threading And Continuity

## Goal

Group related owner/assistant exchanges into durable conversation threads so
follow-up messages can refer to prior work without relying only on recency.

## Implementation Scope

- Add a lightweight thread model using PostgreSQL/in-memory store support.
- Thread records should include:
  - id;
  - user id;
  - title/topic;
  - status: active, waiting, resolved, archived;
  - last owner intent summary;
  - unresolved question;
  - linked task ids;
  - linked message ids;
  - linked memory paths;
  - created/updated timestamps.
- Add store APIs and migration/schema updates.
- Update owner inbound handling to:
  - attach messages to an existing active thread when clear;
  - create a new thread for new topics;
  - pass recent active/resolved thread summaries into the owner prompt.
- Add model tools if useful:
  - `list_conversation_threads`;
  - `update_conversation_thread`;
  - `link_conversation_thread`.
- Ensure the model cannot link another user's records.

## Expected Behavior

Follow-ups such as "what happened with that thing from yesterday?" should have a
structured thread surface to inspect. Threading should help the model decide
whether to update an existing task, answer from memory, create a new task, or
ask for clarification.

## Suggested Tests

- Store migration/schema round trip for threads.
- Owner messages can create/link/update thread state.
- Prompt includes bounded recent thread context.
- Tools validate user scope and reject missing/foreign ids.
- Existing unthreaded flows still work.

## Docs

Update:

- `docs/architecture/30-domain-model.md`
- `docs/architecture/50-agent-runtime.md`
- `docs/architecture/60-connectors-and-side-effects.md`
- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

## Commit

Commit message:

```text
Add conversation threading
```

