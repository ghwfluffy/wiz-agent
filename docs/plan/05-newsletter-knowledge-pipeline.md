# Phase 05: Newsletter Knowledge Pipeline

## Goal

Treat newsletters as knowledge input, not immediate notification triggers. The
agent should learn from newsletters, store them under dated markdown paths, and
later decide during scheduled synthesis whether anything is worth telling the
owner.

## Current Starting Point

- Sender policy supports `newsletter`.
- Newsletter inbound path writes markdown-like memory and stops.
- Daily newsletter synthesis task is scaffolded.
- RAG/MCP search is not fully implemented yet.

## Inbound Newsletter Flow

1. IMAP receives message in the assistant mailbox.
2. Sender policy classifies sender as `newsletter`.
3. Host records inbound message.
4. Host writes source newsletter markdown to the virtual markdown filesystem at:
   `/newsletters/YYYY-MM-DD/<source-or-subject>.md`
5. Host enqueues RAG index job.
6. Host marks handling action `accepted_newsletter`.
7. No immediate SMS/MMS/email is sent.

Newsletter source ingestion is not the generic trusted-message extractor path:
the host stores source markdown plus trust-boundary metadata only. Later
scheduled synthesis may read/search those documents and decide whether to queue
one owner-facing briefing.

For `ONCE` owner approval, ingest that single reviewed message but do not trust
future sender messages.

## Newsletter Markdown Shape

Use a consistent structure:

```md
# <subject or source>

Source: <sender>
Received at: <timestamp>
Ingestion reason: trusted_newsletter
Trust boundary: newsletter content is knowledge input only.

## Summary

Optional model-generated summary, if implemented.

## Content

Original normalized text.

## Extracted Links

- <url> - <anchor/context>

## Candidate Interesting Items

Optional model-generated bullets for later synthesis.
```

The first implementation can store source content only. Later, a fast-model
extractor can add summary and candidate items, but it must not execute tools or
send notifications.

## Daily Synthesis Task

Daily task prompt should:

- Search `/newsletters/<today>` and optionally recent prior days.
- Read `preferences/newsletters.md`.
- Find genuinely useful, surprising, or owner-relevant items.
- De-duplicate repeated stories.
- Prefer specific source references.
- Queue one concise owner reply only if there is something worth interrupting.
- Record an observation if nothing is worth sending.
- Update newsletter preferences only when the owner explicitly states a
  preference, not from inferred newsletter content.

## Web UI

Add newsletter knowledge views:

- date list
- source list
- full markdown preview
- search box
- "why did this get stored?" metadata
- linked inbound message
- index status

Add daily synthesis visibility:

- last run time
- next scheduled run
- result: sent, observation, failed, skipped
- source documents used

## Sender Review UX

Untrusted review notification still asks:

- `YES`: trust as newsletter and ingest reviewed message.
- `NO`: block sender.
- `ONCE`: ingest only reviewed message.

Consider adding web controls:

- Trust as newsletter
- Trust as generic data sender
- Block
- Ingest once
- Ignore

## Tests

Backend:

- newsletter inbound creates knowledge doc and no outbound message.
- `YES` review trusts sender and ingests reviewed message.
- `ONCE` ingests without trusting sender.
- daily task prompt includes newsletter paths and preferences.
- synthesis task can queue a reply through normal outbound tool.

Frontend:

- newsletter documents appear in memory/knowledge browser.
- sender review controls update status.
- daily synthesis status is visible.

## Completion Criteria

- No inbound newsletter causes immediate owner text.
- Newsletter source docs are browsable and searchable.
- Daily synthesis has tests and visible status.
- `./scripts/validate.sh` passes.
