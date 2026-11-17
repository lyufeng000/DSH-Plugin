import { createHash } from 'node:crypto';
import { UserError, VERSION, object, modelFields } from './model.js';

// Verified against the bundled pi-ai provider definitions; unknown defaults are not guessed.
// azure/azure-openai-responses covers the pi-ai 1.1.0 rename (the old route id is kept so a
// migrated profile still resolves its credential instead of failing on a missing reference).
export const DEFAULT_REFS = {
  __proto__: null,
  'ant-ling': 'ANT_LING_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  azure: 'AZURE_OPENAI_API_KEY',
  'azure-openai-responses': 'AZURE_OPENAI_API_KEY',
  baseten: 'BASETEN_API_KEY',
  cerebras: 'CEREBRAS_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  fireworks: 'FIREWORKS_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
  google: 'GEMINI_API_KEY',
  groq: 'GROQ_API_KEY',
  huggingface: 'HF_TOKEN',
  'kimi-coding': 'KIMI_API_KEY',
  meta: 'META_API_KEY',
  minimax: 'MINIMAX_API_KEY',
  'minimax-cn': 'MINIMAX_CN_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  moonshotai: 'MOONSHOT_API_KEY',
  'moonshotai-cn': 'MOONSHOT_API_KEY',
  nvidia: 'NVIDIA_API_KEY',
  openai: 'OPENAI_API_KEY',
  opencode: 'OPENCODE_API_KEY',
  'opencode-go': 'OPENCODE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  'qwen-token-plan': 'QWEN_TOKEN_PLAN_API_KEY',
  'qwen-token-plan-cn': 'QWEN_TOKEN_PLAN_CN_API_KEY',
  'qwen-token-plan-individual': 'QWEN_TOKEN_PLAN_API_KEY',
  radius: 'RADIUS_API_KEY',
  together: 'TOGETHER_API_KEY',
  typesafe: 'TYPESAFE_API_KEY',
  'vercel-ai-gateway': 'AI_GATEWAY_API_KEY',
  xai: 'XAI_API_KEY',
  xiaomi: 'XIAOMI_API_KEY',
  'xiaomi-token-plan-ams': 'XIAOMI_TOKEN_PLAN_AMS_API_KEY',
  'xiaomi-token-plan-cn': 'XIAOMI_TOKEN_PLAN_CN_API_KEY',
  'xiaomi-token-plan-sgp': 'XIAOMI_TOKEN_PLAN_SGP_API_KEY',
  zai: 'ZAI_API_KEY',
  'zai-coding-cn': 'ZAI_CODING_CN_API_KEY',
};
export function configSnapshot(ctx) {
  const entries = ctx.configEditor.entries();
  const matches = ctx.configEditor.configuration().filter(row => entries.includes(row.entry) && row.entry.options?.name === '@deepseek-ai/dsh-llm-pi-ai');
  if (matches.length !== 1) throw new UserError('CONFIG_UNAVAILABLE', '未找到唯一的 llm-pi-ai 配置条目，请检查插件是否已启用。');
  const row = matches[0];
  const current = structuredClone(row.entry.options.config ?? {});
  return { ...row, current, revision: revisionOf(current, row.inherited) };
}
export function revisionOf(current, inherited) {
  return createHash('sha256').update(JSON.stringify([current, inherited])).digest('hex');
}
export function metadata(value) {
  const result = { configured: value?.configured === true, writable: value?.writable === true };
  if (['env', 'environment', 'file', 'record'].includes(value?.source)) result.source = value.source;
  return result;
}
export class ProbeManager {
  constructor(ctx, credentialsModule) { this.ctx = ctx; this.credentialsModule = credentialsModule; }
  snapshot() { return configSnapshot(this.ctx); }
  async state(snapshot = this.snapshot()) {
    const { current, revision } = snapshot;
    const providers = object(current.providers) ? current.providers : {};
    const routes = [];
    for (const [route, config] of Object.entries(providers)) {
      if (!object(config)) continue;
      const explicit = typeof config.apiKeyEnv === 'string' ? config.apiKeyEnv : null;
      const ref = explicit ?? DEFAULT_REFS[route] ?? null;
      let credential = { configured: false, writable: false }, credentialKind = 'unknown';
      if (ref) {
        credential = metadata(await this.ctx.credentials.describe(this.credentialsModule.credentialRef(ref)));
        credentialKind = 'api-key';
      }
      if (!explicit && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route)) {
        const key = this.credentialsModule.credentialKey('llm-pi-ai', route);
        const record = metadata(await this.ctx.credentials.describeRecord(key));
        if (record.configured) { credential = { ...record, source: 'record' }; credentialKind = 'record'; }
      }
      let served = [], available = true;
      try {
        served = (await this.ctx.llm.listModels(route)).map(x => modelFields({ id: x.id, name: x.name, input: x.inputModalities }));
      } catch { available = false; }
      const declared = Array.isArray(config.models) ? config.models.map(modelFields) : null;
      routes.push({ route, apiKeyEnv: explicit, credentialRef: ref, credentialKind, credential, served, declared, available });
    }
    return { version: VERSION, revision, routes };
  }
}
