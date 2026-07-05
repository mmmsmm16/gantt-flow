// AI プロバイダ抽象（desktop 側）。共通パイプライン:
//   requestProposals（オプトインガード）→ プロバイダ（JSON テキスト取得）→
//   core の parseProposals で BatchOp[] を厳密検証（最終防衛線）。
//
// **オフライン既定・オプトイン（最重要）**: requestProposals は先頭で aiEnabled を確認し、
// false なら fetch も SDK 生成も一切せずに throw する（ai-provider.test.ts のスパイで固定）。
import Anthropic from '@anthropic-ai/sdk';
import { parseProposals, type BatchOp } from '@gantt-flow/core';
import { useUI } from '../ui/useUI';
import {
  loadProviderConfig,
  type AiProviderConfig,
  type AnthropicConfig,
  type AzureConfig,
} from './config';
import { buildSystemPrompt, buildUserPrompt, type ProposalRequest } from './prompt';

export type { ProposalRequest } from './prompt';

// ---- エラー ----

export type AiErrorKind =
  | 'disabled'
  | 'auth'
  | 'rateLimit'
  | 'connection'
  | 'schema'
  | 'refusal'
  | 'unknown';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  constructor(kind: AiErrorKind, message: string) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
  }
}

// UI 文言（日本語・再生成可否を含む）。
export const AI_ERROR_TEXT: Record<AiErrorKind, string> = {
  disabled: 'AI アシストは無効です。設定から有効にしてください。',
  auth: 'API キーが正しくありません。設定を確認してから、もう一度お試しください。',
  rateLimit: 'API の利用上限に達しました。しばらく待ってから再生成してください。',
  connection: 'API に接続できませんでした。ネットワークを確認して再生成してください。',
  schema: 'AI の応答を解釈できませんでした。もう一度生成してください。',
  refusal: 'AI がこの要求への応答を拒否しました。メモの内容を見直してください。',
  unknown: '予期しないエラーが発生しました。もう一度お試しください。',
};

// ---- 提案スキーマ（手書き JSON Schema） ----
//
// 注: core の ProposalsSchema は zod v3 で構築されているが、公式 SDK の
// `zodOutputFormat` は内部で zod/v4 の `toJSONSchema` を呼ぶため v3 スキーマでは実行時に
// 例外になる。依存追加（zod→JSON Schema 変換）も禁止のため、`{ operations: BatchOp[] }` を
// 手書きの JSON Schema でモデルに与える。網羅は緩くてよい（最終ゲートは core の
// parseProposals＝zod v3 の厳密検証）。
export const PROPOSALS_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: {
            type: 'string',
            enum: [
              'add_task',
              'upsert_task',
              'add_dependency',
              'set_detail',
              'set_tobe',
              'add_io',
              'add_issue',
              'set_procedure',
              'add_step',
              'upsert_asset',
            ],
          },
          ref: { type: 'string' },
          name: { type: 'string' },
          level: { type: 'string', enum: ['large', 'medium', 'small', 'detail'] },
          parent: { type: 'string' },
          assignee: { type: 'string' },
          assigneeId: { type: 'string' },
          kind: { type: 'string', enum: ['milestone'] },
          from: { type: 'string' },
          to: { type: 'string' },
          task: { type: 'string' },
          patch: { type: 'object', additionalProperties: true },
          io: { type: 'string', enum: ['inputs', 'outputs'] },
          formInfo: { type: 'string' },
          source: { type: 'string' },
          issue: { type: 'string' },
          measure: { type: 'string' },
          purpose: { type: 'string' },
          action: { type: 'string' },
          why: { type: 'string' },
          bodyMd: { type: 'string' },
          id: { type: 'string' },
          desc: { type: 'string' },
          alias: { type: 'string' },
          relPath: { type: 'string' },
          url: { type: 'string' },
        },
        required: ['op'],
      },
    },
  },
  required: ['operations'],
} as const;

// ---- プロバイダ IF ----

export interface AiProvider {
  /** プロンプトを組み立てて生成し、**JSON テキスト**を返す（検証は共通層 requestProposals が行う）。 */
  generateProposals(req: ProposalRequest, onProgress?: (chunk: string) => void): Promise<string>;
}

// ---- Anthropic（公式 SDK・dangerouslyAllowBrowser） ----

export class AnthropicProvider implements AiProvider {
  private client: Anthropic;
  constructor(private cfg: AnthropicConfig) {
    this.client = new Anthropic({ apiKey: cfg.apiKey, dangerouslyAllowBrowser: true });
  }

  async generateProposals(
    req: ProposalRequest,
    onProgress?: (chunk: string) => void,
  ): Promise<string> {
    try {
      const stream = this.client.messages.stream({
        model: this.cfg.model,
        max_tokens: 64000,
        thinking: { type: 'adaptive' },
        system: buildSystemPrompt(),
        messages: [{ role: 'user', content: buildUserPrompt(req) }],
        output_config: { format: { type: 'json_schema', schema: PROPOSALS_JSON_SCHEMA } },
      });
      if (onProgress) stream.on('text', (t: string) => onProgress(t));
      const final = await stream.finalMessage();

      // 拒否は content より先に確認する。
      if (final.stop_reason === 'refusal') {
        throw new AiError('refusal', AI_ERROR_TEXT.refusal);
      }
      // 構造化出力が自動パースされていればそれを、無ければ text ブロック結合を返す。
      // （どちらも requestProposals の parseProposals を再度通る＝最終防衛線）
      const parsed = (final as { parsed_output?: unknown }).parsed_output;
      if (parsed != null) return JSON.stringify(parsed);
      return final.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
    } catch (e) {
      throw mapAnthropicError(e);
    }
  }
}

/** Anthropic の typed error / 自前 AiError を UI 文言付き AiError へ写像する。 */
function mapAnthropicError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof Anthropic.AuthenticationError) return new AiError('auth', AI_ERROR_TEXT.auth);
  if (e instanceof Anthropic.RateLimitError) return new AiError('rateLimit', AI_ERROR_TEXT.rateLimit);
  if (e instanceof Anthropic.APIConnectionError)
    return new AiError('connection', AI_ERROR_TEXT.connection);
  if (e instanceof Anthropic.APIError) return new AiError('unknown', AI_ERROR_TEXT.unknown);
  return new AiError('unknown', AI_ERROR_TEXT.unknown);
}

// ---- Azure OpenAI（生 fetch） ----

interface AzureChatResponse {
  choices?: { message?: { content?: unknown } }[];
}

export class AzureOpenAiProvider implements AiProvider {
  constructor(private cfg: AzureConfig) {}

  async generateProposals(
    req: ProposalRequest,
    _onProgress?: (chunk: string) => void,
  ): Promise<string> {
    // 末尾スラッシュを正規化して URL を組み立てる。
    const base = this.cfg.endpoint.replace(/\/+$/, '');
    const url =
      `${base}/openai/deployments/${this.cfg.deployment}` +
      `/chat/completions?api-version=${this.cfg.apiVersion}`;
    const system = buildSystemPrompt();
    const user = buildUserPrompt(req);

    // 1回目: response_format = json_schema（strict）。
    let res = await this.post(url, system, user, {
      type: 'json_schema',
      json_schema: { name: 'proposals', schema: PROPOSALS_JSON_SCHEMA, strict: true },
    });

    // 400（未対応デプロイ等）なら json_object にフォールバックし、システム側で JSON を明示指示。
    if (res.status === 400) {
      res = await this.post(
        url,
        system + '\n\n重要: 応答は必ず JSON オブジェクトのみで返してください（説明文を混ぜない）。',
        user,
        { type: 'json_object' },
      );
    }

    if (res.status === 401) throw new AiError('auth', AI_ERROR_TEXT.auth);
    if (res.status === 429) throw new AiError('rateLimit', AI_ERROR_TEXT.rateLimit);
    if (!res.ok) throw new AiError('unknown', `${AI_ERROR_TEXT.unknown}（HTTP ${res.status}）`);

    let data: AzureChatResponse;
    try {
      data = (await res.json()) as AzureChatResponse;
    } catch {
      throw new AiError('schema', AI_ERROR_TEXT.schema);
    }
    const content = data.choices?.[0]?.message?.content;
    // 文字列 JSON をそのまま返す（検証は requestProposals の parseProposals）。
    return typeof content === 'string' ? content : JSON.stringify(content);
  }

  private post(
    url: string,
    system: string,
    user: string,
    responseFormat: Record<string, unknown>,
  ): Promise<Response> {
    return fetch(url, {
      method: 'POST',
      headers: { 'api-key': this.cfg.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: responseFormat,
      }),
    }).catch(() => {
      // ネットワーク例外 → connection。
      throw new AiError('connection', AI_ERROR_TEXT.connection);
    });
  }
}

// ---- Mock（テスト/E2E 用・設定に依らず注入可） ----

export class MockAiProvider implements AiProvider {
  constructor(private cannedJson: string) {}
  async generateProposals(
    _req: ProposalRequest,
    onProgress?: (chunk: string) => void,
  ): Promise<string> {
    onProgress?.(this.cannedJson);
    return this.cannedJson;
  }
}

export function createProvider(cfg: AiProviderConfig): AiProvider {
  return cfg.kind === 'azure-openai' ? new AzureOpenAiProvider(cfg) : new AnthropicProvider(cfg);
}

// ---- 唯一の生成エントリ（ガード→プロバイダ→共通検証を貫く） ----

/**
 * オプトインガード付きの提案生成。**先頭で aiEnabled を確認し、false なら
 * provider 構築・fetch・SDK 生成より前に throw する**（オフライン既定の実装保証）。
 */
export async function requestProposals(
  req: ProposalRequest,
  onProgress?: (chunk: string) => void,
  providerOverride?: AiProvider,
): Promise<BatchOp[]> {
  // ① オプトインガード（最重要・この throw が provider 構築/fetch/SDK 生成より前）。
  if (!useUI.getState().aiEnabled) {
    throw new AiError('disabled', AI_ERROR_TEXT.disabled);
  }

  // ② プロバイダ解決（override が無ければ設定から合成）。
  let provider = providerOverride;
  if (!provider) {
    const cfg = loadProviderConfig();
    if (cfg === null) {
      throw new AiError('unknown', 'API キーが未設定です。設定から AI プロバイダのキーを入力してください。');
    }
    provider = createProvider(cfg);
  }

  // ③ 生成（JSON テキスト取得）。
  const jsonText = await provider.generateProposals(req, onProgress);

  // ④ 共通検証（最終防衛線）。ZodError/SyntaxError は AiError('schema') へ写像。
  try {
    return parseProposals(jsonText).operations;
  } catch (e) {
    if (e instanceof AiError) throw e;
    throw new AiError('schema', AI_ERROR_TEXT.schema);
  }
}
