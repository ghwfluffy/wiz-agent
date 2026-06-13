export const INITIAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  is_admin BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  value TEXT NOT NULL,
  verified_at TIMESTAMPTZ,
  is_primary BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kind, value)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS oauth_state_records (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  state_hash TEXT NOT NULL UNIQUE,
  code_verifier TEXT NOT NULL,
  next_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS connectors (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS connector_secret_refs (
  id TEXT PRIMARY KEY,
  connector_id TEXT NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  secret_ref TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  external_thread_key TEXT,
  active_task_id TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connector_id TEXT REFERENCES connectors(id) ON DELETE SET NULL,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  direction TEXT NOT NULL,
  source TEXT NOT NULL,
  provider_message_id TEXT,
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  body_text TEXT,
  body_hash TEXT,
  auth_status TEXT,
  auth_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  received_at TIMESTAMPTZ,
  raw_object_key TEXT,
  normalized_object_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  kind TEXT NOT NULL DEFAULT 'manual',
  title TEXT NOT NULL,
  prompt TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  priority INTEGER NOT NULL DEFAULT 0,
  recurrence_rule TEXT,
  created_by TEXT NOT NULL,
  approval_required BOOLEAN NOT NULL DEFAULT false,
  max_runtime_sec INTEGER NOT NULL DEFAULT 120,
  max_tool_calls INTEGER NOT NULL DEFAULT 10,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  schedule_source TEXT,
  schedule_context_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS task_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  action_type TEXT NOT NULL,
  source_run_id TEXT,
  source_ref TEXT,
  risk_level TEXT NOT NULL DEFAULT 'high',
  summary TEXT NOT NULL DEFAULT '',
  expires_at TIMESTAMPTZ,
  action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by TEXT NOT NULL,
  decided_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS senders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, address)
);

CREATE TABLE IF NOT EXISTS memory_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, slug)
);

CREATE TABLE IF NOT EXISTS memory_revisions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES memory_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  proposed_body TEXT NOT NULL,
  rationale TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS markdown_documents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  basename TEXT NOT NULL,
  title TEXT,
  markdown TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version BIGINT NOT NULL DEFAULT 1,
  index_status TEXT NOT NULL DEFAULT 'pending',
  indexed_version BIGINT,
  indexed_content_hash TEXT,
  indexed_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, path)
);

CREATE TABLE IF NOT EXISTS markdown_sections (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES markdown_documents(id) ON DELETE CASCADE,
  document_version BIGINT NOT NULL,
  section_id TEXT NOT NULL,
  parent_section_id TEXT,
  heading TEXT NOT NULL,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  level INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, document_id, document_version, section_id)
);

CREATE TABLE IF NOT EXISTS markdown_document_chunks (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES markdown_documents(id) ON DELETE CASCADE,
  document_version BIGINT NOT NULL,
  section_id TEXT,
  heading_path JSONB NOT NULL DEFAULT '[]'::jsonb,
  chunk_index INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  qdrant_point_id TEXT NOT NULL,
  qdrant_collection TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  indexed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, document_id, chunk_index),
  UNIQUE (qdrant_point_id)
);

CREATE TABLE IF NOT EXISTS rag_index_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL,
  requested_version BIGINT,
  requested_content_hash TEXT,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rag_user_indexes (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  qdrant_collection TEXT NOT NULL UNIQUE,
  collection_exists BOOLEAN NOT NULL DEFAULT false,
  last_collection_check_at TIMESTAMPTZ,
  last_reconciliation_started_at TIMESTAMPTZ,
  last_reconciliation_completed_at TIMESTAMPTZ,
  expected_document_count BIGINT NOT NULL DEFAULT 0,
  expected_chunk_count BIGINT NOT NULL DEFAULT 0,
  qdrant_point_count BIGINT,
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_error TEXT,
  embedding_model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dimensions INTEGER NOT NULL DEFAULT 1536,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  approval_id TEXT REFERENCES approvals(id) ON DELETE SET NULL,
  channel TEXT NOT NULL,
  status TEXT NOT NULL,
  to_addr TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  failure_message TEXT
);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fetched_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS article_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  link_id TEXT NOT NULL REFERENCES links(id) ON DELETE CASCADE,
  title TEXT,
  extracted_text TEXT,
  object_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  status TEXT NOT NULL,
  model_tier TEXT NOT NULL,
  model_id TEXT NOT NULL,
  prompt_version TEXT,
  token_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  failure_message TEXT
);

CREATE TABLE IF NOT EXISTS agent_mcp_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE CASCADE,
  allowed_tools_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT REFERENCES agent_runs(id) ON DELETE SET NULL,
  tool_name TEXT NOT NULL,
  status TEXT NOT NULL,
  arguments_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  validation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  request_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_ai_config (
  id TEXT PRIMARY KEY,
  config_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status_due ON tasks(user_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_user_created ON audit_log(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_started ON agent_runs(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_approvals_user_status_created ON approvals(user_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_markdown_documents_user_path ON markdown_documents(user_id, path);
CREATE INDEX IF NOT EXISTS idx_markdown_sections_document_version ON markdown_sections(document_id, document_version);
CREATE INDEX IF NOT EXISTS idx_rag_index_jobs_status_available ON rag_index_jobs(status, available_at, created_at);
CREATE INDEX IF NOT EXISTS idx_agent_mcp_sessions_token ON agent_mcp_sessions(token_hash) WHERE revoked_at IS NULL;
`;
