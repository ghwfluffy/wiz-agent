# Phase 06: Personal Memory Lists

## Goal

Make personal "offload my memory to the bot" lists reliable, recallable, and
easy to update through natural owner language.

Examples:

- "add Desperado to my movies list"
- "that should go on the movie night pile"
- "keep track of this as a project idea"
- "don't let me forget that restaurant"
- "save that as something to research later"

The owner will not use consistent wording. The assistant must infer the intent
to preserve an item for later recall, then use deterministic list tools instead
of free-form memory appends.

## Sub-Agent Prompt

Implement Phase 06 from `docs/plans/06-personal-memory-lists.md`.
Read `docs/plans/README.md`, `docs/architecture/50-agent-runtime.md`,
`docs/architecture/60-connectors-and-side-effects.md`, and
`docs/architecture/30-domain-model.md`.

Add structured personal memory list tools backed by markdown memory, prompt
guidance for varied owner phrasing, tests, and docs. Commit with message:
`Add personal memory list tools`.

## Product Intent

Markdown should remain the durable storage substrate, but list operations need
more structure than generic `write_memory`.

The agent should reliably support:

- adding an item to a named list;
- reading/listing items later;
- finding likely lists from loose wording;
- avoiding duplicates;
- preserving useful notes and source context;
- removing or archiving an item when asked;
- treating list items as memory, not tasks, unless the owner asks for action.

Prompt guidance should be intent-based. It should not depend on exact phrases
such as "add X to my Y list".

## Canonical Storage

Use predictable markdown paths:

- `/personal/lists/movies.md`
- `/personal/lists/project-ideas.md`
- `/personal/lists/books.md`
- `/personal/lists/restaurants.md`
- `/personal/lists/research.md`

Allow arbitrary list names, normalized to a slug:

- owner phrase: "movie night pile"
- canonical list id/path: `movies` or `movie-night`
- markdown path: `/personal/lists/movie-night.md`

Each list file should have a stable heading and machine-friendly list entries.
Recommended format:

```md
# Movies

<!-- memory-list:v1 list_id="movies" -->

- [ ] Desperado
  - added: 2026-06-13T15:00:00.000Z
  - source: owner_message:<message-id>
  - notes: Owner wants to watch this later.
```

Keep the format simple enough for humans to edit, but structured enough for
tools to parse without brittle ad hoc behavior.

## MCP Tools

Add model-facing tools such as:

- `add_memory_list_item`
- `list_memory_items`
- `search_memory_lists`
- `remove_memory_list_item`
- `update_memory_list_item`

Recommended tool contract details:

### `add_memory_list_item`

Inputs:

- `listName`: owner-facing name or inferred category;
- `item`: item display text;
- `notes`: optional note;
- `sourceMessageId`: optional, host/context-derived when available;
- `rationale`: why this belongs in durable list memory.

Behavior:

- normalize list path under `/personal/lists/`;
- create the list if missing;
- detect duplicates case-insensitively and with light punctuation normalization;
- append a structured item if not duplicate;
- return path, item id, duplicate status, and current item count.

### `list_memory_items`

Inputs:

- `listName` or `path`;
- optional status filter such as active/archived.

Behavior:

- read the canonical markdown list;
- return bounded structured items;
- include path and last updated time.

### `search_memory_lists`

Inputs:

- free-form query;
- optional limit.

Behavior:

- search known `/personal/lists/` files by title, aliases, and item text;
- optionally use existing markdown exact/RAG search when available;
- return candidate lists/items and confidence hints.

### `remove_memory_list_item` / `update_memory_list_item`

Prefer archiving over deletion unless the owner clearly asks to delete.
Preserve history when useful:

```md
- [x] Desperado
  - archived: 2026-06-20T10:00:00.000Z
  - archive_reason: Watched.
```

## Prompt Guidance

Update owner inbound and web prompt guidance so the model recognizes varied
phrasing.

Guidance should say:

- When the owner expresses an intent to preserve an item for later recall,
  categorization, recommendation, comparison, or future discussion, treat it as
  a memory-list operation.
- The owner may not say "remember", "add", or "list".
- Use personal memory list tools for movies, books, project ideas, gift ideas,
  restaurants, research topics, places, things to buy, or other lightweight
  collections.
- Do not create a task unless the owner asks the assistant to do work.
- Do not use generic `write_memory` for simple list add/remove/read operations
  when a list tool fits.

Examples the prompt should support:

- "Desperado should go with the movies."
- "That is one for movie night."
- "Keep this around as a project idea."
- "Save that restaurant."
- "Put this in my someday research bucket."
- "What movies were on my watch list?"
- "What was that Antonio Banderas movie I wanted to watch?"

## Recall Behavior

Later recall should work even when the owner asks indirectly:

- "what westerns did I want to watch?"
- "what was that movie night idea?"
- "show me project ideas about the house"
- "what restaurants did I save?"

Use `search_memory_lists` before falling back to broad markdown/RAG search.
The answer should cite the list name/path when useful and avoid pretending
uncertain matches are certain.

## UI

Do not block this phase on a rich UI. A minimal Memory tab improvement is enough
if easy:

- show `/personal/lists/` as a recognizable area;
- render checklist-style markdown lists cleanly;
- optionally add a simple "Lists" filter.

Tool correctness matters more than UI polish for this phase.

## Acceptance Criteria

- The agent has MCP tools for structured personal list add/read/search/update
  behavior.
- List files are stored under `/personal/lists/` with stable, parseable markdown.
- Owner prompt guidance recognizes inconsistent wording as list intent.
- Duplicate adds are idempotent and return duplicate information.
- List recall can find items by list name or fuzzy item query.
- List operations are user-scoped and audited.
- Generic memory behavior still works for non-list durable facts/preferences.

## Tests

Add tests for:

- "add Desperado to my movies list" creates `/personal/lists/movies.md`;
- alternate wording such as "that is one for movie night" routes to list tools
  in prompt/model tests;
- duplicate add does not create a second item;
- `list_memory_items` returns the saved item;
- `search_memory_lists` finds the item from indirect query terms;
- archive/remove marks an item inactive without losing history by default;
- list tools reject paths outside `/personal/lists/`;
- cross-user list access is impossible;
- owner prompt includes intent-based list guidance.

Run:

```bash
cd api && npm test -- agentRuntime.test.ts markdownMemory.test.ts
./scripts/validate.sh
```
