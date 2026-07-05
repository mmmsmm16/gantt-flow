// AI プロバイダ設定・モデル・API キーの保管（gf-ai-* localStorage ＋ セッションメモリ）。
//
// セキュリティ規律（サイクル4「AI アシスト」の最重要事項）:
//  - **API キーは Project にも SettingsFile にも入れない**。存在場所は
//    ①セッションメモリ（このモジュールの `memKeys`。リロードで消える）と
//    ②「この PC に保存」チェック時のみ `gf-ai-key-<kind>` localStorage（平文）だけ。
//  - autosave/backups/.gflow は Project をシリアライズするだけで、Project にキー欄が無い
//    ことが構造的保証。SettingsFile（settings.ts）にもキー項目を一切足さない。
import type { Project, Id } from '@gantt-flow/core';

export type AiProviderKind = 'anthropic' | 'azure-openai';
export type AiModel = 'claude-opus-4-8' | 'claude-sonnet-5' | 'claude-haiku-4-5';

// 選択肢（既定＝先頭 = claude-opus-4-8）。ID 文字列はモデルの正確な識別子。
export const AI_MODELS: AiModel[] = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'];

export interface AnthropicConfig {
  kind: 'anthropic';
  apiKey: string;
  model: AiModel;
}
export interface AzureConfig {
  kind: 'azure-openai';
  apiKey: string;
  endpoint: string;
  deployment: string;
  apiVersion: string;
}
export type AiProviderConfig = AnthropicConfig | AzureConfig;

// localStorage キー。**キー本体は gf-ai-key-* のみ**（Project/SettingsFile には出さない）。
export const LS = {
  enabled: 'gf-ai',
  provider: 'gf-ai-provider',
  model: 'gf-ai-model',
  azure: 'gf-ai-azure',
} as const;
// 「この PC に保存」チェック時のみ・平文で置く: gf-ai-key-anthropic / gf-ai-key-azure-openai
export const KEY_PREFIX = 'gf-ai-key-';

// セッションメモリ（既定の置き場所。リロードで揮発。localStorage には出さない）。
const memKeys: Partial<Record<AiProviderKind, string>> = {};

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 永続化失敗は無視（メモリ上は反映済み） */
  }
}
function lsDel(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 無視 */
  }
}

/** API キーを取得。セッションメモリを優先し、無ければ localStorage の平文保存を読む。 */
export function getApiKey(kind: AiProviderKind): string | undefined {
  return memKeys[kind] ?? lsGet(KEY_PREFIX + kind) ?? undefined;
}

/**
 * API キーを設定する。常にセッションメモリに保持し、`persist=true` のときだけ
 * localStorage に平文保存する。`persist=false` は localStorage の保存を消す（メモリのみ）。
 */
export function setApiKey(kind: AiProviderKind, key: string, persist: boolean): void {
  memKeys[kind] = key;
  if (persist) lsSet(KEY_PREFIX + kind, key);
  else lsDel(KEY_PREFIX + kind);
}

/** 保存済み（localStorage 平文）のキーをすべて消す。メモリは触らない。 */
export function clearPersistedKeys(): void {
  lsDel(KEY_PREFIX + 'anthropic');
  lsDel(KEY_PREFIX + 'azure-openai');
}

/** プロバイダ種別・モデル・Azure 接続先を保存する（キーは含めない）。 */
export function saveProviderSettings(v: {
  kind: AiProviderKind;
  model?: AiModel;
  azure?: Omit<AzureConfig, 'kind' | 'apiKey'>;
}): void {
  lsSet(LS.provider, v.kind);
  if (v.model) lsSet(LS.model, v.model);
  if (v.azure) lsSet(LS.azure, JSON.stringify(v.azure));
}

/**
 * 現在のプロバイダ設定を合成して返す。キー（メモリ or localStorage）が未設定なら null。
 * Azure は endpoint/deployment/apiVersion が揃っていなければ null。
 */
export function loadProviderConfig(): AiProviderConfig | null {
  const kind: AiProviderKind = lsGet(LS.provider) === 'azure-openai' ? 'azure-openai' : 'anthropic';
  const apiKey = getApiKey(kind);
  if (!apiKey) return null;

  if (kind === 'azure-openai') {
    const raw = lsGet(LS.azure);
    let azure: Partial<Omit<AzureConfig, 'kind' | 'apiKey'>> = {};
    try {
      azure = raw ? (JSON.parse(raw) as Omit<AzureConfig, 'kind' | 'apiKey'>) : {};
    } catch {
      azure = {};
    }
    if (!azure.endpoint || !azure.deployment || !azure.apiVersion) return null;
    return {
      kind: 'azure-openai',
      apiKey,
      endpoint: azure.endpoint,
      deployment: azure.deployment,
      apiVersion: azure.apiVersion,
    };
  }

  const savedModel = lsGet(LS.model);
  const model: AiModel = AI_MODELS.includes(savedModel as AiModel)
    ? (savedModel as AiModel)
    : AI_MODELS[0]!;
  return { kind: 'anthropic', apiKey, model };
}

// buildUserPrompt が参照する型の再エクスポート（ai/ 内で完結させるため）。
export type { Project, Id };
