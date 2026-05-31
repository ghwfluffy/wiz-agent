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
API. Real OpenAI wiring must remain behind `AgentModelClient`.
