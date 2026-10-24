import { Type, type Static, type TProperties, type TSchema } from '@sinclair/typebox';
import { AVAILABILITIES, BROKER_STATES, ERROR_STATUS, LIMITS, MESSAGE_STATUSES, PROFILE_IDS, RUN_STATUSES, TERMINATION_REASONS } from './constants.js';

const object = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
const enumeration = <T extends string>(values: readonly T[]) => Type.Union(values.map(value => Type.Literal(value)));
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const integer = (minimum = 0) => Type.Integer({ minimum, maximum: Number.MAX_SAFE_INTEGER });
const text = (maxLength = 512) => Type.String({ minLength: 1, maxLength });
const envelope = <T extends TSchema>(schema: T) => object({ data: schema });

export const UuidSchema = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' });
export const TimestampSchema = Type.String({ pattern: '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])T([01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{3})?Z$' });
export const DigestSchema = Type.String({ pattern: '^[a-f0-9]{64}$' });
export const ModelNameSchema = Type.String({ minLength: 1, maxLength: 256, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$' });
export const ProfileIdSchema = enumeration(PROFILE_IDS);
export const RunStatusSchema = enumeration(RUN_STATUSES);
export const BrokerStateSchema = enumeration(BROKER_STATES);
export const AvailabilitySchema = enumeration(AVAILABILITIES);
export const ErrorCodeSchema = enumeration(Object.keys(ERROR_STATUS) as Array<keyof typeof ERROR_STATUS>);
export const TitleSchema = Type.String({ minLength: 1, maxLength: LIMITS.titleCodePoints, pattern: '\\S' });
export const EmptyRequestSchema = object({});
export const ResourceParamsSchema = object({ id: UuidSchema });
export const ProfileParamsSchema = object({ id: ProfileIdSchema });

export const GenerationOptionsSchema = object({
  numCtx: Type.Union([Type.Literal(4096), Type.Literal(2048)]),
  numPredict: Type.Literal(512), temperature: Type.Literal(0.7), think: Type.Literal(false),
});
export const ChatSchema = object({
  id: UuidSchema, title: TitleSchema, profileId: ProfileIdSchema, version: integer(1),
  createdAt: TimestampSchema, updatedAt: TimestampSchema, activeRunId: nullable(UuidSchema),
});
export const RunSchema = object({
  id: UuidSchema, chatId: UuidSchema, userMessageId: UuidSchema, assistantMessageId: UuidSchema,
  status: RunStatusSchema, profileId: ProfileIdSchema, modelName: ModelNameSchema, modelDigest: DigestSchema,
  options: GenerationOptionsSchema, inputEstimate: integer(), omittedMessageCount: integer(),
  finishReason: nullable(enumeration(['stop', 'length'])), errorCode: nullable(ErrorCodeSchema),
  terminationReason: nullable(enumeration(TERMINATION_REASONS)),
  createdAt: TimestampSchema, firstContentAt: nullable(TimestampSchema), endedAt: nullable(TimestampSchema),
  metrics: object({
    promptTokens: nullable(integer()), generatedTokens: nullable(integer()),
    loadMs: nullable(Type.Number({ minimum: 0 })), totalMs: nullable(Type.Number({ minimum: 0 })),
    evalMs: nullable(Type.Number({ minimum: 0 })),
  }),
});
const messageFields = {
  id: UuidSchema, chatId: UuidSchema, seq: integer(1), createdAt: TimestampSchema,
  updatedAt: TimestampSchema, runId: UuidSchema,
};
export const MessageSchema = Type.Union([
  object({ ...messageFields, role: Type.Literal('user'), content: Type.String({ minLength: 1, maxLength: LIMITS.userContentBytes, pattern: '\\S' }), status: Type.Literal('completed'), modelName: Type.Null(), modelDigest: Type.Null(), profileId: Type.Null() }),
  object({ ...messageFields, role: Type.Literal('assistant'), content: Type.String({ maxLength: LIMITS.assistantContentBytes }), status: enumeration(MESSAGE_STATUSES), modelName: ModelNameSchema, modelDigest: DigestSchema, profileId: ProfileIdSchema }),
]);

export const CreateChatRequestSchema = object({ profileId: Type.Optional(ProfileIdSchema), title: Type.Optional(TitleSchema) });
export const UpdateChatRequestSchema = Type.Intersect([
  object({ expectedVersion: integer(1), title: Type.Optional(TitleSchema), profileId: Type.Optional(ProfileIdSchema) }),
  Type.Union([Type.Object({ title: TitleSchema }), Type.Object({ profileId: ProfileIdSchema })]),
]);
export const DeleteChatRequestSchema = object({ expectedVersion: integer(1) });
export const TurnRequestSchema = object({ content: Type.String({ minLength: 1, maxLength: LIMITS.userContentBytes, pattern: '\\S' }), expectedVersion: integer(1) });
export const BindProfileRequestSchema = Type.Union([
  object({ modelName: ModelNameSchema, expectedDigest: DigestSchema, expectedVersion: integer(1) }),
  object({ modelName: Type.Null(), expectedDigest: Type.Null(), expectedVersion: integer(1) }),
]);
export const ChatsQuerySchema = object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.maxPageSize })), cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })) });
export const MessagesQuerySchema = object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.maxPageSize })), beforeSeq: Type.Optional(integer(1)) });
export const IdempotencyKeySchema = UuidSchema;

export const ModelProfileSchema = object({
  id: ProfileIdSchema, label: text(120), modelName: nullable(ModelNameSchema), boundDigest: nullable(DigestSchema),
  version: integer(1), availability: AvailabilitySchema, reasonCode: nullable(ErrorCodeSchema), reason: nullable(text(512)),
});
export const InstalledModelSchema = object({ name: ModelNameSchema, digest: DigestSchema, sizeBytes: integer(), quantization: nullable(text(64)), capabilities: Type.Array(text(64), { maxItems: 32, uniqueItems: true }), eligible: Type.Boolean(), reasonCode: nullable(ErrorCodeSchema) });
export const ModelsResponseSchema = envelope(object({
  checkedAt: nullable(TimestampSchema), stale: Type.Boolean(), ollamaVersion: nullable(text(64)),
  installed: Type.Array(InstalledModelSchema), profiles: Type.Tuple([
    Type.Intersect([ModelProfileSchema, Type.Object({ id: Type.Literal('general') })]),
    Type.Intersect([ModelProfileSchema, Type.Object({ id: Type.Literal('abliterated') })]),
  ]),
}));
export const SessionResponseSchema = envelope(object({ token: Type.String({ pattern: '^[A-Za-z0-9_-]{43}$' }), apiVersion: Type.Literal(1) }));
export const HealthResponseSchema = envelope(object({
  apiVersion: Type.Literal(1), appStatus: enumeration(['setup', 'ready', 'degraded']),
  databaseStatus: enumeration(['not_initialized', 'ready', 'unavailable']),
  ollamaStatus: enumeration(['not_checked', 'reachable', 'unavailable']), brokerState: BrokerStateSchema,
  activeRunId: nullable(UuidSchema),
}));
export const ChatResponseSchema = envelope(ChatSchema);
export const RunResponseSchema = envelope(RunSchema);
export const ProfileResponseSchema = envelope(ModelProfileSchema);
export const ChatsResponseSchema = envelope(object({ items: Type.Array(ChatSchema, { maxItems: 100 }), nextCursor: nullable(Type.String({ minLength: 1, maxLength: 512, pattern: '^[A-Za-z0-9_-]+$' })) }));
export const MessagesResponseSchema = envelope(object({ items: Type.Array(MessageSchema, { maxItems: 100 }), nextBeforeSeq: nullable(integer(1)) }));
export const CancelAcceptedResponseSchema = envelope(object({ runId: UuidSchema, cancelRequested: Type.Literal(true) }));
export const ErrorResponseSchema = object({ error: object({
  code: ErrorCodeSchema, message: text(512), retryable: Type.Boolean(), requestId: UuidSchema,
  details: Type.Optional(object({ profileId: Type.Optional(ProfileIdSchema), currentVersion: Type.Optional(integer(1)), maxBytes: Type.Optional(integer(1)), inputBudget: Type.Optional(integer(1)), runId: Type.Optional(UuidSchema), userMessageId: Type.Optional(UuidSchema), assistantMessageId: Type.Optional(UuidSchema) })),
}) });

const event = <N extends string, D extends TSchema>(name: N, data: D) => object({ id: integer(1), event: Type.Literal(name), data });
export const AcceptedEventSchema = event('accepted', object({ runId: UuidSchema, userMessageId: UuidSchema, assistantMessageId: UuidSchema, chatVersion: integer(1), profileId: ProfileIdSchema, modelName: ModelNameSchema, modelDigest: DigestSchema, inputEstimate: integer(), omittedMessageCount: integer() }));
export const StatusEventSchema = event('status', object({ phase: enumeration(['preparing_model', 'generating']) }));
export const DeltaEventSchema = event('delta', object({ text: Type.String({ maxLength: LIMITS.assistantContentBytes }) }));
export const DoneEventSchema = event('done', object({ run: Type.Intersect([RunSchema, Type.Object({ status: enumeration(['completed', 'cancelled']) })]) }));
export const ErrorEventSchema = event('error', object({ runId: UuidSchema, code: ErrorCodeSchema, message: text(512), retryable: Type.Boolean() }));
export const StreamEventSchema = Type.Union([AcceptedEventSchema, StatusEventSchema, DeltaEventSchema, DoneEventSchema, ErrorEventSchema]);

export type ProfileId = Static<typeof ProfileIdSchema>;
export type RunStatus = Static<typeof RunStatusSchema>;
export type BrokerState = Static<typeof BrokerStateSchema>;
export type Availability = Static<typeof AvailabilitySchema>;
export type Chat = Static<typeof ChatSchema>;
export type Message = Static<typeof MessageSchema>;
export type Run = Static<typeof RunSchema>;
export type TurnRequest = Static<typeof TurnRequestSchema>;
export type StreamEvent = Static<typeof StreamEventSchema>;
export type HealthResponse = Static<typeof HealthResponseSchema>;
export type SessionResponse = Static<typeof SessionResponseSchema>;
export type ModelProfile = Static<typeof ModelProfileSchema>;

export type CreateChatRequest = Static<typeof CreateChatRequestSchema>;
export type UpdateChatRequest = Static<typeof UpdateChatRequestSchema>;
export type DeleteChatRequest = Static<typeof DeleteChatRequestSchema>;
export type BindProfileRequest = Static<typeof BindProfileRequestSchema>;
export type ModelsResponse = Static<typeof ModelsResponseSchema>;
export type ErrorResponse = Static<typeof ErrorResponseSchema>;
export type CancelAcceptedResponse = Static<typeof CancelAcceptedResponseSchema>;
