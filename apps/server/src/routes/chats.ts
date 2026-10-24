import type { FastifyPluginAsync, FastifySerializerCompiler } from 'fastify';
import {
  API_PREFIX, ChatResponseSchema, ChatsQuerySchema, ChatsResponseSchema, ContractError,
  CreateChatRequestSchema, DeleteChatRequestSchema, EmptyRequestSchema, ErrorResponseSchema,
  MessagesQuerySchema, MessagesResponseSchema, ResourceParamsSchema, UpdateChatRequestSchema, parseContract,
} from '@localmind/contracts';
import type { ChatService } from '../services/chats.js';

export function chatRoutes(service: ChatService): FastifyPluginAsync {
  return async app => {
    const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
    const serializerCompiler: FastifySerializerCompiler<unknown> = ({ schema }) => {
      const known = [ChatResponseSchema, ChatsResponseSchema, MessagesResponseSchema, ErrorResponseSchema].find(item => item === schema);
      if (!known) throw new Error('Unsupported chat response schema.');
      return value => JSON.stringify(parseContract(known, value));
    };
    const options = { serializerCompiler };
    // HTTP query values are strings; convert only canonical positive integers, never bodies.
    app.addHook('preValidation', async request => {
      const query = request.query as Record<string, unknown>;
      for (const key of ['limit', 'beforeSeq']) {
        const value = query[key];
        if (value === undefined) continue;
        if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ContractError('VALIDATION_ERROR');
        query[key] = Number(value);
      }
    });
    app.post(API_PREFIX + '/chats', { ...options, schema: { body: CreateChatRequestSchema, querystring: EmptyRequestSchema, response: { 201: ChatResponseSchema, ...errors } } }, async (request, reply) => reply.code(201).send({ data: service.create(request.body) }));
    app.get(API_PREFIX + '/chats', { ...options, schema: { querystring: ChatsQuerySchema, response: { 200: ChatsResponseSchema, ...errors } } }, async request => ({ data: service.list(request.query) }));
    app.get<{ Params: { id: string } }>(API_PREFIX + '/chats/:id', { ...options, schema: { params: ResourceParamsSchema, querystring: EmptyRequestSchema, response: { 200: ChatResponseSchema, ...errors } } }, async request => ({ data: service.get(request.params.id) }));
    app.patch<{ Params: { id: string } }>(API_PREFIX + '/chats/:id', { ...options, schema: { params: ResourceParamsSchema, querystring: EmptyRequestSchema, body: UpdateChatRequestSchema, response: { 200: ChatResponseSchema, ...errors } } }, async request => ({ data: await service.update(request.params.id, request.body) }));
    app.delete<{ Params: { id: string } }>(API_PREFIX + '/chats/:id', { ...options, schema: { params: ResourceParamsSchema, querystring: EmptyRequestSchema, body: DeleteChatRequestSchema, response: errors } }, async (request, reply) => {
      service.remove(request.params.id, request.body); return reply.code(204).send();
    });
    app.get<{ Params: { id: string } }>(API_PREFIX + '/chats/:id/messages', { ...options, schema: { params: ResourceParamsSchema, querystring: MessagesQuerySchema, response: { 200: MessagesResponseSchema, ...errors } } }, async request => ({ data: service.messages(request.params.id, request.query) }));
  };
}
