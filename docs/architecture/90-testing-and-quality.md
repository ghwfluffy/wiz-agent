# Testing And Quality

Validation is part of the baseline scaffold.

## Commands

Run the full validation flow:

```bash
./scripts/validate.sh
```

Targeted commands:

```bash
./api/lint.sh
./api/test.sh
./web/test.sh
./web/build.sh
```

## Baseline Coverage

Current tests cover:

- API config loading.
- status route.
- standalone development auto-login.
- core schema table coverage.
- API error envelope.
- task user ownership.
- admin audit and AI config authorization.
- model tier selection.
- structured tool-call validation and repair.
- failed repair rejection.
- mock model agent runs.
- OpenAI Responses API adapter request/response parsing.
- deterministic local tool execution.
- run/tool-call audit traceability.
- sender classification and untrusted-message handling.
- untrusted sender rate limiting.
- due task claiming.
- task event listing and follow-up prompt handoff.
- safe URL rejection.
- MMS image sanitization policy.
- cross-app integration token enforcement.
- app capability registry coverage for Goals and Fluffynomics.
- allowlisted integration-action request resolution.
- frontend base-path helpers.
- sign-in button behavior.
- OAuth login redirect, callback failure handling, and callback session
  creation.
- live config seeding from ignored connector files.
- user-managed connector configuration with API-redacted credentials.
- IMAP settings tests with redacted provider errors.
- incremental IMAP search criteria from stored mailbox progress.
- worker IMAP failure audit visibility.
- sender-table owner classification.
- owner-contact backed untrusted sender review notification queueing.
- owner SMS sender-review replies for newsletter trust, one-time review, and
  blocking.
- trusted newsletter digest task queueing with owner preference memory.
- newsletter preference memory writes from explicit owner messages.
- memory document API and Memory tab rendering.
- owner reply tool contract without model-selected recipients.
- outbound fail-closed recipient checks and raw owner mobile gateway mapping.
- outbox listing, status updates, SMTP queue delivery, and fail-closed outbound
  delivery.
- operations dashboard rendering.
- tabbed Carbon dashboard rendering, URL-backed active tabs, and focused tab
  polling.

Future phases should add migration, user ownership, authorization, worker,
tool-call, connector, and admin UI tests alongside the feature work. Tenant
removal migrations and no-tenant API responses need explicit coverage so the
collapsed ownership model does not regress.
