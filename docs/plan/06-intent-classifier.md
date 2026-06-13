# Phase 06: Owner Message Intent Classifier

## Goal

Add a deterministic intent envelope around owner messages to reduce misrouting.
The classifier should guide the model without replacing model judgment.

## Implementation Scope

- Add host-side classifier logic for likely owner intent:
  - memory/list offload;
  - task creation;
  - task update;
  - question/answer request;
  - approval response;
  - preference correction;
  - app action request;
  - casual conversation;
  - clarification response;
  - unknown.
- Include confidence and short evidence strings.
- Store intent classification on inbound handling/audit where practical.
- Pass the intent envelope into owner inbound prompts:
  - "host detected likely memory-list offload; verify and act accordingly."
- Keep the classifier conservative. It should not create side effects by itself.
- Favor simple deterministic heuristics and existing structured context. Avoid a
  new model call unless strongly justified.

## Expected Behavior

The model still decides, but it receives a better starting point for messages
like:

- "add Desperado to my movies list";
- "that was just something to remember";
- "move that task to tomorrow";
- "yes";
- "don't text me that early";
- "what was the Banderas movie?"

## Suggested Tests

- Unit tests for classification examples and confidence.
- Owner prompt includes the classification envelope.
- Approval replies and trust replies do not regress.
- Classification is user-scoped and non-secret in audit/handling metadata.

## Docs

Update:

- `docs/architecture/50-agent-runtime.md`
- `docs/architecture/60-connectors-and-side-effects.md`
- `docs/architecture/90-testing-and-quality.md`
- `docs/development.md`

## Commit

Commit message:

```text
Add owner intent classification
```

