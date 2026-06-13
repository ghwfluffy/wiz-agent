# Phase 01: Memory Filesystem And MCP Tools

## Goal

Replace ad hoc memory document access with a server-owned virtual markdown
filesystem exposed through MCP. Agents should interact with memory like files
and sections, while the server maps every request to the authenticated user and
enforces access control.

## Current Starting Point

- `memory_documents` stores simple slug/title/body records.
- `markdown_documents`, `markdown_sections`, `markdown_document_chunks`,
  `rag_index_jobs`, and `rag_user_indexes` exist in the schema.
- `api/src/mcp/server.ts` is a health/status scaffold.
- Local tools include `write_memory`, but this should become an MCP-backed
  operation.

## Required Behavior

- Store markdown files as Postgres rows, not filesystem files.
- Use paths such as:
  - `/personal/profile.md`
  - `/preferences/newsletters.md`
  - `/assistant/schedule.md`
  - `/assistant/notification-policy.md`
  - `/tasks/schedule-rationale.md`
  - `/projects/<project>/decisions.md`
  - `/newsletters/YYYY-MM-DD/source.md`
- Agents never provide user IDs or Qdrant collection names.
- MCP server derives user scope from the authenticated agent/session token.
- Writes update source markdown rows, parse sections, and enqueue index jobs.

## Data Model Work

Add or complete store methods around the markdown tables:

- `listMarkdownDirectory(context, path)`
- `getMarkdownDocument(context, path, version?)`
- `writeMarkdownDocument(context, input)`
- `deleteMarkdownPath(context, path)`
- `moveMarkdownPath(context, from, to)`
- `listMarkdownSections(context, path)`
- `readMarkdownSection(context, path, sectionId)`
- `replaceMarkdownSection(context, path, sectionId, markdown)`
- `appendMarkdownSection(context, path, sectionId, markdown)`
- `searchMarkdownExact(context, query)`

Use optimistic concurrency:

- Full-file writes should accept `expectedVersion`.
- Section edits should validate against the current document version.
- Return a structured conflict error if versions mismatch.

## Markdown Parsing

Implement a deterministic parser module:

- Parse headings levels 1 through 6.
- Generate stable section IDs from heading path, e.g. `goals/mvp`.
- Record `line_start`, `line_end`, heading path, parent section, and content
  hash.
- Treat pre-heading content as a synthetic section such as `_preamble`.
- Preserve original markdown formatting on full-file reads.

Avoid fragile regex-only editing for section replacement. Use parsed line ranges
from the current document version.

## MCP Tool Surface

Implement these initial MCP tools:

- `list_dir({ path })`
- `tree({ path?, maxDepth? })`
- `stat_path({ path })`
- `read_file({ path, version? })`
- `write_file({ path, content, expectedVersion? })`
- `delete_path({ path, expectedVersion? })`
- `move_path({ from, to, expectedVersions? })`
- `read_section({ path, sectionId })`
- `replace_section({ path, sectionId, content, expectedVersion })`
- `append_to_section({ path, sectionId, content, expectedVersion? })`
- `search_headings({ query?, pathPrefix?, maxDepth? })`
- `grep({ pattern, pathPrefix?, caseSensitive?, regex?, contextLines?, limit? })`
- `get_index_status({ path? })`
- `reindex_path({ path })`

Do not expose admin-only index rebuild tools to the model yet.

## Authentication And Authorization

Design an MCP session/token layer:

- API/worker creates a short-lived server-side agent session for a specific
  user and run.
- MCP receives the token and resolves it to user/run context.
- MCP rejects requests with missing, expired, or mismatched run context.
- MCP logs tool name, user id, run id when present, path, and outcome.

Do not accept `userId`, `tenantId`, `collection`, or credential references in
tool arguments.

## Migration Strategy

Write a migration/backfill that maps existing `memory_documents` into markdown
paths:

- `personal-profile` -> `/personal/profile.md`
- `newsletter-preferences` -> `/preferences/newsletters.md`
- `agent-schedule` -> `/assistant/schedule.md`
- `newsletters-YYYY-MM-DD-*` style slugs -> `/newsletters/YYYY-MM-DD/*.md`
- fallback -> `/legacy/<slug>.md`

Keep existing UI/API compatibility initially by having memory document endpoints
read from the new markdown store or by dual-writing during the transition.

## API Compatibility

Keep existing `GET /api/v1/memory` and `GET /api/v1/memory/:slug` working until
the web UI is migrated. Add new endpoints only for human/UI needs, not for model
access:

- `GET /api/v1/knowledge/tree`
- `GET /api/v1/knowledge/files?path=...`
- `GET /api/v1/knowledge/files/:encodedPath`
- `PUT /api/v1/knowledge/files/:encodedPath`
- `GET /api/v1/knowledge/files/:encodedPath/sections`

## Tests

Backend tests:

- user A cannot read/write user B paths.
- `write_file` creates sections and index job.
- `replace_section` edits only the target section.
- stale `expectedVersion` returns conflict.
- `move_path` updates all matching document paths and queues reindex jobs.
- `grep` handles plain text and regex safely.
- MCP rejects requests without valid agent session.

Schema/migration tests:

- existing `memory_documents` are backfilled to expected paths.
- repeated migration is idempotent.
- deleted paths do not appear in `list_dir` or `tree`.

Docs:

- Update `docs/architecture/30-domain-model.md`.
- Update `docs/architecture/50-agent-runtime.md`.
- Update `docs/development.md` with MCP local workflow.

## Completion Criteria

- MCP can read/write user-scoped markdown files.
- Section parsing and section edits are deterministic and tested.
- Writes enqueue RAG jobs.
- Existing web memory view still works or has a documented replacement.
- `./scripts/validate.sh` passes.
