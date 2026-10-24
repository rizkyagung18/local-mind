export const names = ['qwen3.5:2b-q4_K_M', 'huihui_ai/qwen3.5-abliterated:2B'] as const;
export function metadataFixtures() {
  return {
    tags: { models: names.map((name, i) => ({ name, digest: (i ? 'b' : 'a').repeat(64), size: 1_900_000_000 })) },
    show: { details: { format: 'gguf', quantization_level: 'Q4_K_M' },
      model_info: { 'general.architecture': 'qwen35', 'general.file_type': 15 },
      capabilities: ['completion', 'thinking'], thinking: { values: [false, true], default: true } },
    version: { version: '0.40.3' }, ps: { models: [] as { name: string; digest: string }[] },
  };
}
