import type { FastifyPluginAsync, FastifySerializerCompiler } from 'fastify';
import { API_PREFIX, BindProfileRequestSchema, EmptyRequestSchema, ErrorResponseSchema, ModelsResponseSchema, ProfileParamsSchema, ProfileResponseSchema, parseContract, type ProfileId } from '@localmind/contracts';
import type { ModelRegistry } from '../services/models.js';

export function modelRoutes(registry: ModelRegistry): FastifyPluginAsync {
  return async app => {
    const errors = { '4xx': ErrorResponseSchema, '5xx': ErrorResponseSchema };
    // Preserve the shared tuple/intersection contract that fast-json-stringify cannot merge.
    const serializerCompiler: FastifySerializerCompiler<unknown> = ({ schema }) => {
      if (schema !== ModelsResponseSchema && schema !== ErrorResponseSchema) throw new Error('Unsupported model response schema.');
      const responseSchema = schema === ModelsResponseSchema ? ModelsResponseSchema : ErrorResponseSchema;
      return value => JSON.stringify(parseContract(responseSchema, value));
    };
    app.get(API_PREFIX + '/models', { serializerCompiler, schema: { querystring: EmptyRequestSchema, response: { 200: ModelsResponseSchema, ...errors } } }, async () => registry.get());
    app.post(API_PREFIX + '/models/refresh', { serializerCompiler, schema: { body: EmptyRequestSchema, querystring: EmptyRequestSchema, response: { 200: ModelsResponseSchema, ...errors } } }, async () => registry.refresh());
    app.patch<{ Params: { id: ProfileId } }>(API_PREFIX + '/model-profiles/:id', {
      schema: { params: ProfileParamsSchema, body: BindProfileRequestSchema, querystring: EmptyRequestSchema, response: { 200: ProfileResponseSchema, ...errors } },
    }, async request => ({ data: await registry.bind(request.params.id, request.body) }));
  };
}
