# Development

## Prerequisites

- Docker and Docker Compose.
- Node.js 20+ when running API or web checks outside containers.

## Local Mode

Early development uses standalone mode:

```bash
cp .env.example .env
docker compose up --build
```

The Vite web app runs at `http://localhost:18081` by default. The
production-style Nginx service runs at `http://localhost:18082`, the MCP service
runs at `http://localhost:18083`, Qdrant runs at `http://localhost:6333`, and
the API is available at `http://localhost:18080`. In standalone mode, the
sign-in button calls `POST /api/v1/auth/dev-login` and creates a session for the
configured development user.

The home screen is the operational dashboard. It supports creating and updating
tasks, approving or cancelling outbound messages, managing sender trust,
inspecting worker queue status, viewing recent audit history, and editing admin
AI model configuration when the signed-in user is an administrator. OAuth
callback failures redirect back to the UI with an `oauth_error` token; the web
store converts that token into a friendly message and removes it from the URL.

API and worker startup run the TypeScript migration runner before serving:

```bash
cd api
npm run migrate
```

Standalone mode is only for local development. It is not production auth.

## Services

- `db`: local Postgres.
- `qdrant`: local derived vector index for RAG search state.
- `api`: Hono API.
- `worker`: worker process stub.
- `rag-worker`: background RAG/index reconciliation entrypoint.
- `mcp`: server-side agent tool boundary for memory/RAG tools.
- `web`: Vite development server.
- `nginx`: production-style local static/proxy service.

## Validation

Run the full validation flow from the repository root:

```bash
./scripts/validate.sh
```

Run targeted checks while iterating:

```bash
./api/lint.sh
./api/test.sh
./web/test.sh
./web/build.sh
```

Agent runtime tests use `MockModelClient`; validation does not call the OpenAI
API. Real OpenAI wiring must remain behind `AgentModelClient`. To run real
model calls locally, set `AGENT_OPENAI_API_KEY` in your ignored local env file
or point `AGENT_OPENAI_API_KEY_FILE` at an ignored file. `AGENT_OPENAI_BASE_URL`
defaults to `https://api.openai.com/v1`.

Live connector config can be seeded from ignored files for initial bootstrap or
repair with:

```bash
cd api
AGENT_SEED_USER_EMAIL=person@example.test npm run seed:live-config -- --secret-dir ../secrets --dry-run
```

The dry run reports which settings are present without printing secret values.
The non-dry-run path requires an existing local agent user created by standalone
or OAuth sign-in.

The seed command reads legacy/bootstrap files:

- `contact.json` for owner email/SMS/MMS gateway addresses;
- `email.json` for IMAP/SMTP connector metadata;
- `openai.txt` when `AGENT_OPENAI_API_KEY_FILE` points at the mounted secret
  file.

Normal user setup happens through the web Settings tab. Each user owns their
contact details, SMS/MMS gateway addresses, assistant mailbox identity, IMAP
settings, and SMTP settings. The webmaster-owned OpenAI API key remains
deployment configuration.

Connector and integration tests also avoid live networks. They use deterministic
sender classification, mock fetch implementations, and outbox records instead of
real IMAP, SMTP, SMS, MMS, or cross-app API calls.

## MCP Local Workflow

The local MCP service is the server-side memory/RAG tool boundary. It runs in
Docker on `http://localhost:18083` or directly from the API package:

```bash
cd api
npm run mcp
```

Host code creates a short-lived MCP bearer token for the current authenticated
user with `POST /api/v1/agent/mcp-sessions`. The MCP service then accepts JSON
tool calls at `POST /mcp/v1/tools/:tool` with `Authorization: Bearer <token>`.
Agents and tests should pass file paths and content only; they must not pass
`userId`, tenant, Qdrant collection, connector credential, or recipient fields.

Human/UI knowledge inspection uses:

```text
GET /api/v1/knowledge/tree
GET /api/v1/knowledge/files?path=/assistant
GET /api/v1/knowledge/files/:encodedPath
PUT /api/v1/knowledge/files/:encodedPath
GET /api/v1/knowledge/files/:encodedPath/sections
```

Encode full markdown paths for `:encodedPath`, for example
`%2Fpersonal%2Fprofile.md`.
