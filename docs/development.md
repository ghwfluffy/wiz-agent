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
production-style Nginx service runs at `http://localhost:18082`, and the API is
available at `http://localhost:18080`. In standalone mode, the
sign-in button calls `POST /api/v1/auth/dev-login` and creates a session for the
configured development user.

API and worker startup run the TypeScript migration runner before serving:

```bash
cd api
npm run migrate
```

Standalone mode is only for local development. It is not production auth.

## Services

- `db`: local Postgres.
- `api`: Hono API.
- `worker`: worker process stub.
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
model calls locally, set `AGENT_OPENAI_API_KEY` in your ignored local env file.
`AGENT_OPENAI_BASE_URL` defaults to `https://api.openai.com/v1`.

Live connector config can be seeded from ignored files with:

```bash
cd api
AGENT_SEED_USER_EMAIL=person@example.test npm run seed:live-config -- --secret-dir ../secrets --dry-run
```

The dry run reports which settings are present without printing secret values.
The non-dry-run path requires an existing local agent user created by standalone
or OAuth sign-in.

Connector and integration tests also avoid live networks. They use deterministic
sender classification, mock fetch implementations, and outbox records instead of
real IMAP, SMTP, SMS, MMS, or cross-app API calls.
