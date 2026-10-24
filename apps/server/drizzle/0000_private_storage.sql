CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY NOT NULL CHECK (id IN ('general','abliterated')),
  label TEXT NOT NULL,
  model_name TEXT,
  bound_digest TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE chats (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  title_source TEXT NOT NULL CHECK (title_source IN ('default','derived','manual')),
  profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  next_message_seq INTEGER NOT NULL DEFAULT 1 CHECK (next_message_seq > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
--> statement-breakpoint
CREATE INDEX chats_updated ON chats(updated_at DESC, id DESC);
--> statement-breakpoint
CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL CHECK (seq > 0),
  role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('pending','streaming','completed','cancelled','failed','interrupted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(chat_id,seq),
  CHECK (role <> 'user' OR (status = 'completed' AND length(trim(content, char(9)||char(10)||char(13)||' ')) > 0)),
  CHECK (length(CAST(content AS BLOB)) <= CASE role WHEN 'user' THEN 16384 ELSE 65536 END)
) STRICT;
--> statement-breakpoint
CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  assistant_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  status TEXT NOT NULL CHECK (status IN ('preparing','streaming','completed','cancelled','failed','interrupted')),
  profile_id TEXT NOT NULL REFERENCES model_profiles(id) ON DELETE RESTRICT,
  model_name TEXT NOT NULL,
  model_digest TEXT NOT NULL CHECK (length(model_digest)=64 AND model_digest NOT GLOB '*[^0-9a-f]*'),
  options_json TEXT NOT NULL CHECK (json_valid(options_json) AND json_type(options_json)='object'),
  system_prompt_version TEXT NOT NULL,
  input_estimate INTEGER NOT NULL CHECK (input_estimate >= 0),
  omitted_message_count INTEGER NOT NULL CHECK (omitted_message_count >= 0),
  included_message_ids_json TEXT NOT NULL CHECK (json_valid(included_message_ids_json) AND json_type(included_message_ids_json)='array'),
  finish_reason TEXT CHECK (finish_reason IN ('stop','length')),
  error_code TEXT CHECK (error_code IN ('VALIDATION_ERROR','SESSION_REQUIRED','LOCAL_ACCESS_DENIED','NOT_FOUND','VERSION_CONFLICT','CHAT_ACTIVE','GENERATION_BUSY','DUPLICATE_REQUEST','IDEMPOTENCY_CONFLICT','MODEL_CHANGED','OLLAMA_IN_USE','PAYLOAD_TOO_LARGE','CONTEXT_TOO_LARGE','MODEL_MISSING','MODEL_INCOMPATIBLE','PROVIDER_ERROR','INVALID_PROVIDER_STREAM','UNSUPPORTED_MODEL_OUTPUT','OUTPUT_TOO_LARGE','OLLAMA_UNAVAILABLE','RUNTIME_BLOCKED','STORAGE_UNAVAILABLE','GENERATION_INTERRUPTED','GENERATION_TIMEOUT','INTERNAL_ERROR')),
  termination_reason TEXT CHECK (termination_reason IN ('user_stop','client_disconnect','timeout','provider_error','storage_error','server_shutdown','server_restart')),
  prompt_tokens INTEGER CHECK (prompt_tokens >= 0),
  generated_tokens INTEGER CHECK (generated_tokens >= 0),
  load_ms REAL CHECK (load_ms >= 0),
  total_ms REAL CHECK (total_ms >= 0),
  eval_ms REAL CHECK (eval_ms >= 0),
  created_at INTEGER NOT NULL,
  first_content_at INTEGER,
  ended_at INTEGER,
  UNIQUE(chat_id,idempotency_key),
  CHECK (user_message_id <> assistant_message_id),
  CHECK ((status IN ('preparing','streaming') AND ended_at IS NULL) OR (status NOT IN ('preparing','streaming') AND ended_at IS NOT NULL))
) STRICT;
--> statement-breakpoint
CREATE INDEX runs_chat_created ON runs(chat_id,created_at,id);
--> statement-breakpoint
CREATE UNIQUE INDEX one_active_run ON runs((1)) WHERE status IN ('preparing','streaming');
--> statement-breakpoint
CREATE TRIGGER permanent_profiles BEFORE DELETE ON model_profiles BEGIN SELECT RAISE(ABORT,'Permanent profile'); END;
--> statement-breakpoint
CREATE TRIGGER permanent_profile_ids BEFORE UPDATE OF id ON model_profiles BEGIN SELECT RAISE(ABORT,'Permanent profile ID'); END;
--> statement-breakpoint
CREATE TRIGGER run_message_pair BEFORE INSERT ON runs
WHEN NOT EXISTS (SELECT 1 FROM messages WHERE id=NEW.user_message_id AND chat_id=NEW.chat_id AND role='user')
  OR NOT EXISTS (SELECT 1 FROM messages WHERE id=NEW.assistant_message_id AND chat_id=NEW.chat_id AND role='assistant')
BEGIN SELECT RAISE(ABORT,'Invalid message pair'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_run_snapshot BEFORE UPDATE OF id,chat_id,user_message_id,assistant_message_id,idempotency_key,request_hash,profile_id,model_name,model_digest,options_json,system_prompt_version,input_estimate,omitted_message_count,included_message_ids_json,created_at ON runs
BEGIN SELECT RAISE(ABORT,'Immutable run snapshot'); END;
--> statement-breakpoint
CREATE TRIGGER terminal_run_immutable BEFORE UPDATE ON runs WHEN OLD.status IN ('completed','cancelled','failed','interrupted')
BEGIN SELECT RAISE(ABORT,'Terminal run'); END;
--> statement-breakpoint
CREATE TRIGGER run_no_rewind BEFORE UPDATE OF status ON runs WHEN OLD.status='streaming' AND NEW.status='preparing'
BEGIN SELECT RAISE(ABORT,'Invalid run transition'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_message_identity BEFORE UPDATE OF id,chat_id,seq,role,created_at ON messages
BEGIN SELECT RAISE(ABORT,'Immutable message identity'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_user_message BEFORE UPDATE ON messages WHEN OLD.role='user'
BEGIN SELECT RAISE(ABORT,'Immutable user message'); END;
--> statement-breakpoint
CREATE TRIGGER immutable_terminal_message BEFORE UPDATE ON messages WHEN OLD.status IN ('completed','cancelled','failed','interrupted')
BEGIN SELECT RAISE(ABORT,'Terminal message'); END;
