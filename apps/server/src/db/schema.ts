import { desc, sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { ERROR_STATUS, type Run } from '@localmind/contracts';

export const modelProfiles = sqliteTable('model_profiles', {
  id: text('id', { enum: ['general', 'abliterated'] }).primaryKey(), label: text('label').notNull(),
  modelName: text('model_name'), boundDigest: text('bound_digest'), version: integer('version').notNull().default(1),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [check('profile_id', sql`${t.id} IN ('general','abliterated')`), check('profile_version', sql`${t.version}>0`)]);

export const chats = sqliteTable('chats', {
  id: text('id').primaryKey(), title: text('title').notNull(),
  titleSource: text('title_source', { enum: ['default', 'derived', 'manual'] }).notNull(),
  profileId: text('profile_id').notNull().references(() => modelProfiles.id, { onDelete: 'restrict' }),
  version: integer('version').notNull().default(1), nextMessageSeq: integer('next_message_seq').notNull().default(1),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [index('chats_updated').on(desc(t.updatedAt), desc(t.id)),
  check('chat_title', sql`length(${t.title}) BETWEEN 1 AND 120`),
  check('title_source', sql`${t.titleSource} IN ('default','derived','manual')`),
  check('chat_version', sql`${t.version}>0`), check('message_sequence', sql`${t.nextMessageSeq}>0`)]);

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(), chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  seq: integer('seq').notNull(), role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull().default(''),
  status: text('status', { enum: ['pending', 'streaming', 'completed', 'cancelled', 'failed', 'interrupted'] }).notNull(),
  createdAt: integer('created_at').notNull(), updatedAt: integer('updated_at').notNull(),
}, t => [uniqueIndex('message_sequence_unique').on(t.chatId, t.seq), check('message_seq', sql`${t.seq}>0`),
  check('message_role', sql`${t.role} IN ('user','assistant')`),
  check('message_status', sql`${t.status} IN ('pending','streaming','completed','cancelled','failed','interrupted')`),
  check('user_completed', sql`${t.role}<>'user' OR (${t.status}='completed' AND length(trim(${t.content},char(9)||char(10)||char(13)||' '))>0)`),
  check('message_bytes', sql`length(CAST(${t.content} AS BLOB))<=CASE ${t.role} WHEN 'user' THEN 16384 ELSE 65536 END`)]);

export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(), chatId: text('chat_id').notNull().references(() => chats.id, { onDelete: 'cascade' }),
  userMessageId: text('user_message_id').notNull().unique().references(() => messages.id, { onDelete: 'cascade' }),
  assistantMessageId: text('assistant_message_id').notNull().unique().references(() => messages.id, { onDelete: 'cascade' }),
  idempotencyKey: text('idempotency_key').notNull(), requestHash: text('request_hash').notNull(),
  status: text('status', { enum: ['preparing', 'streaming', 'completed', 'cancelled', 'failed', 'interrupted'] }).notNull(),
  profileId: text('profile_id').notNull().references(() => modelProfiles.id, { onDelete: 'restrict' }),
  modelName: text('model_name').notNull(), modelDigest: text('model_digest').notNull(),
  options: text('options_json', { mode: 'json' }).$type<Run['options']>().notNull(),
  systemPromptVersion: text('system_prompt_version').notNull(),
  inputEstimate: integer('input_estimate').notNull(), omittedMessageCount: integer('omitted_message_count').notNull(),
  includedMessageIds: text('included_message_ids_json', { mode: 'json' }).$type<string[]>().notNull(),
  finishReason: text('finish_reason').$type<Run['finishReason']>(), errorCode: text('error_code').$type<Run['errorCode']>(),
  terminationReason: text('termination_reason').$type<Run['terminationReason']>(),
  promptTokens: integer('prompt_tokens'), generatedTokens: integer('generated_tokens'),
  loadMs: real('load_ms'), totalMs: real('total_ms'), evalMs: real('eval_ms'),
  createdAt: integer('created_at').notNull(), firstContentAt: integer('first_content_at'), endedAt: integer('ended_at'),
}, t => [uniqueIndex('run_idempotency').on(t.chatId, t.idempotencyKey), index('runs_chat_created').on(t.chatId, t.createdAt, t.id),
  uniqueIndex('one_active_run').on(sql`(1)`).where(sql`${t.status} IN ('preparing','streaming')`),
  check('run_status', sql`${t.status} IN ('preparing','streaming','completed','cancelled','failed','interrupted')`),
  check('run_pair', sql`${t.userMessageId}<>${t.assistantMessageId}`),
  check('request_hash', sql`length(${t.requestHash})=64 AND ${t.requestHash} NOT GLOB '*[^0-9a-f]*'`),
  check('model_digest', sql`length(${t.modelDigest})=64 AND ${t.modelDigest} NOT GLOB '*[^0-9a-f]*'`),
  check('options_json', sql`json_valid(${t.options}) AND json_type(${t.options})='object'`),
  check('history_json', sql`json_valid(${t.includedMessageIds}) AND json_type(${t.includedMessageIds})='array'`),
  check('estimates', sql`${t.inputEstimate}>=0 AND ${t.omittedMessageCount}>=0`),
  check('finish_reason', sql`${t.finishReason} IN ('stop','length')`),
  check('error_code', sql`${t.errorCode} IN (${sql.join(Object.keys(ERROR_STATUS).map(code => sql.raw(`'${code}'`)), sql`,`)})`),
  check('termination_reason', sql`${t.terminationReason} IN ('user_stop','client_disconnect','timeout','provider_error','storage_error','server_shutdown','server_restart')`),
  check('metrics', sql`(${t.promptTokens} IS NULL OR ${t.promptTokens}>=0) AND (${t.generatedTokens} IS NULL OR ${t.generatedTokens}>=0) AND (${t.loadMs} IS NULL OR ${t.loadMs}>=0) AND (${t.totalMs} IS NULL OR ${t.totalMs}>=0) AND (${t.evalMs} IS NULL OR ${t.evalMs}>=0)`),
  check('terminal_timestamp', sql`(${t.status} IN ('preparing','streaming') AND ${t.endedAt} IS NULL) OR (${t.status} NOT IN ('preparing','streaming') AND ${t.endedAt} IS NOT NULL)`),
]);

// The reviewed SQL migration additionally owns immutable-row and pairing triggers.
