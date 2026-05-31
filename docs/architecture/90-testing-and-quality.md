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

Phase 1 tests cover:

- API config loading.
- status route.
- standalone development auto-login.
- core schema table coverage.
- API error envelope.
- task tenant/user ownership.
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
- safe URL rejection.
- MMS image sanitization policy.
- cross-app integration token enforcement.
- app capability registry coverage for Goals and Fluffynomics.
- allowlisted integration-action request resolution.
- frontend base-path helpers.
- sign-in button behavior.

Future phases should add migration, tenancy, authorization, worker, tool-call,
connector, and admin UI tests alongside the feature work.
