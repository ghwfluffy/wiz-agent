# Connectors And Side Effects

Connectors and side effects are mediated by deterministic host code.

## Inbound

Initial inbound connector goals:

- poll IMAP;
- parse MIME;
- normalize SMS gateway emails;
- deduplicate provider messages;
- apply sender trust and block policy;
- route messages into conversations and tasks.

## Outbound

Email, SMS, and MMS sends go through an outbox table. Request handlers and model
tools should enqueue proposed sends rather than contacting providers directly.

Outbound side effects may require approval. The first implementation should be
conservative and approval-gated by default.

## MMS Images

MMS image handling must:

- validate content type and byte size;
- strip metadata;
- resize to configured maximum dimensions;
- store sanitized artifact metadata;
- audit the queued and sent states.

## Link Fetching

Safe-fetch code controls network access. It should reject private, loopback,
link-local, and metadata-service addresses; limit redirects; limit response
sizes; and time out aggressively before article extraction or summarization.
