# Phase 02: RAG Indexing And Search

## Goal

Make Qdrant a derived, rebuildable search index for the markdown filesystem.
Agents should use exact search for precision and semantic search for discovery,
without ever choosing collections or bypassing user scope.

## Current Starting Point

- Docker Compose includes a `qdrant` service.
- `rag-worker` exists as a scaffold.
- Schema includes chunk and job tables.
- `qdrantCollectionForUser(userId)` exists as a helper.

## Required Behavior

- Postgres remains the source of truth.
- Qdrant stores derived vectors only.
- One Qdrant collection per user.
- The RAG worker claims jobs durably from Postgres.
- Indexing can resume safely after process restarts.
- Reconciliation can repair missing collections, points, or stale chunk state.

## Store And Job Methods

Add store methods:

- `ensureUserRagIndex(context)`
- `enqueueRagJob(context, documentId, jobType)`
- `claimRagIndexJobs(limit, now)`
- `completeRagIndexJob(jobId)`
- `failRagIndexJob(jobId, error, retryAt?)`
- `markRagIndexJobDead(jobId, error)`
- `replaceDocumentChunks(context, documentId, chunks)`
- `listChunksForDocument(context, documentId)`
- `updateRagIndexHealth(userId, input)`

Job claim query should use `FOR UPDATE SKIP LOCKED` in Postgres.

## Embeddings

Add an embedding boundary similar to `AgentModelClient`:

- `EmbeddingClient.embedTexts({ model, dimensions, texts })`
- `MockEmbeddingClient` for tests.
- `OpenAIEmbeddingClient` for live calls.

Use settings:

- `RAG_EMBEDDING_MODEL`
- `RAG_EMBEDDING_DIMENSIONS`
- `AGENT_OPENAI_API_KEY` or `AGENT_OPENAI_API_KEY_FILE`

Do not call live OpenAI in tests.

## Chunking Rules

Chunk by markdown section first:

- Prefer one chunk per small section.
- Split large sections by paragraph or token-ish length.
- Include heading path and path metadata in each chunk.
- Use deterministic chunk indexes for a given document version.
- Compute `content_hash` for each chunk.
- Use deterministic point IDs so upserts are idempotent.

Payload should include:

- `user_id`
- `document_id`
- `document_version`
- `path`
- `dir`
- `top_level`
- `filename`
- `title`
- `section_id`
- `heading_path`
- `chunk_index`
- `content_hash`
- `embedding_model`
- `indexed_at`

## Qdrant Operations

Implement a small Qdrant client:

- health check
- create collection if missing
- upsert points
- delete points by document id
- search collection with optional path prefix filter
- count points

Fail closed if Qdrant is unavailable. Leave source writes successful but jobs
pending/failed for retry.

## MCP Search Tools

Add MCP tools:

- `search_exact({ query, pathPrefix?, limit? })`
- `search_semantic({ query, pathPrefix?, limit? })`
- `find_backlinks({ path })`
- `get_index_status({ path? })`
- `reindex_path({ path })`

`search_semantic` should return source handles:

- path
- version
- section id
- heading path
- chunk index
- score
- text excerpt

Agents should read the source file/section before making significant memory
edits based on search results.

## Reconciliation

Implement two paths:

- Startup reconciliation: ensure expected collections exist and stale pending
  jobs are made available.
- Periodic reconciliation: compare expected chunk state in Postgres with Qdrant
  point counts and enqueue repair jobs.

Avoid expensive full rebuilds on every start.

## Tests

Unit tests:

- chunking is deterministic.
- section metadata is preserved in chunks.
- point IDs are deterministic.
- path prefix filters compile correctly.

Worker tests:

- claims one or more pending jobs.
- indexes document chunks with mock embeddings and mock Qdrant.
- retries transient failures.
- marks dead after configured attempt limit.
- deletion job removes document points.

Integration-style tests:

- source write enqueues job.
- RAG worker indexes job.
- semantic search returns source handle for the same user only.

Docs:

- Update RAG operations in `docs/development.md`.
- Add testing expectations in `docs/architecture/90-testing-and-quality.md`.

## Completion Criteria

- Writes to markdown memory create index jobs.
- RAG worker indexes and deletes documents idempotently.
- MCP semantic search is user-scoped and tested.
- Reconciliation status is visible in API/logs.
- `./scripts/validate.sh` passes.
