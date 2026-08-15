# Settings And Config Bootstrap

The API loads deployment settings through `api/src/config/settings.ts`. Settings
are fail-fast configuration, not runtime preferences: malformed env values should
stop startup before the app serves requests.

## Sources

- Environment variables provide deploy-time defaults.
- `AGENT_OPENAI_API_KEY_FILE` may point at an ignored mounted secret file. A
  direct `AGENT_OPENAI_API_KEY` or `OPENAI_API_KEY` value takes precedence when
  non-blank.
- `admin_ai_config` stores the administrator-managed model tier and agent run
  budget defaults. It uses one `id = 'default'` row and is upserted
  idempotently.

## Validation

Numeric settings are bounded integers, including ports, session duration, audio
upload size, RAG dimensions and batch size, MCP port, runaway guardrails, and
agent run budgets. Boolean env values are strict: only common true/false tokens
are accepted.

Path settings are path prefixes, not URLs. `APP_BASE_PATH`, `AUTH_BASE_URL`, and
`SESSION_COOKIE_PATH` reject query strings, fragments, dot segments, backslashes,
whitespace, and URL-shaped values. `PUBLIC_URL` is scheme and host only.

List settings such as owner email lists are parsed from comma-separated values,
deduplicated, trimmed, lowercased, and validated as email addresses. Local mode
defaults the owner email list to the development user. Production does not
bootstrap `dev@example.test` as an owner address.

Production settings fail closed when:

- `AUTH_MODE=standalone`;
- `OAUTH_SERVER_BASE_URL` is missing;
- `POSTGRES_PASSWORD` is still the development default;
- `PUBLIC_URL` points at localhost or a wildcard bind address;
- an app base path is configured while the session cookie path remains `/`;
- the owner email list explicitly contains `dev@example.test`;
- a Goals, My Notes, Budget, or Apartment Gate integration URL is configured without
  `AGENT_INTEGRATION_TOKEN_SECRET`.

## Admin AI Config

The capable built-in admin AI defaults are:

- model tiers: `gpt-5-mini` for fast/repair and `gpt-5` for smart/orchestrator;
- `maxToolCalls = 50`;
- `maxRuntimeSec = 500`;
- `repairAttemptLimit = 1`.

Deploy-time env model IDs and AI budget env values seed the default config when
no database row exists. Admin updates validate the complete merged config before
persisting. Model IDs must be non-blank model identifiers, `maxToolCalls` must
be from 1 to 50, `maxRuntimeSec` from 1 to 500, and `repairAttemptLimit` from 0
to 5. `repairAttemptLimit` cannot exceed `maxToolCalls`.

Legacy or manually edited persisted JSON is normalized on read: invalid model
IDs fall back to the safe default, and numeric budgets are clamped into the
accepted range. New admin writes are rejected instead of silently clamped.

## Guardrail Semantics

Burst controls remain present for loop and provider-abuse protection:
`AGENT_MAX_RUNS_PER_USER_PER_BURST_WINDOW`,
`AGENT_RUN_BURST_WINDOW_SECONDS`,
`AGENT_MAX_AUTONOMOUS_RUNS_PER_WORKER_TICK`,
`AGENT_OUTBOUND_MESSAGES_PER_WORKER_TICK`,
`INBOUND_MAX_UNTRUSTED_REVIEW_NOTIFICATIONS_PER_SENDER_PER_DAY`, and
newsletter document caps.

The owner-visible outbound rolling-day cap applies only to autonomous or
proactive owner-visible outreach. It must not become a hard daily usage lockout:
authenticated owner web prompts, owner-classified inbound replies, and due
owner-requested scheduled messages continue to use run burst limits, tool-call
limits, destination validation, and outbox pacing.
