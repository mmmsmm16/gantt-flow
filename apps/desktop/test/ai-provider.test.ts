// AI プロバイダ層のテスト（すべてモック・実 API は叩かない）。
// 最重要: ①aiEnabled=false で fetch/SDK に到達しないオプトインガード
//         ②Azure のリクエスト形状（URL/ヘッダ/response_format）と json_schema→json_object フォールバック
//         ③不正 JSON→schema、Anthropic の stream 形状・refusal・typed error 写像
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Project } from '@gantt-flow/core';
import { BatchOpSchema } from '@gantt-flow/core';
import { useUI } from '../src/ui/useUI';
import { saveProviderSettings, setApiKey } from '../src/ai/config';
import {
  requestProposals,
  MockAiProvider,
  AiError,
  AI_ERROR_TEXT,
  toDisplayError,
  offersSettings,
  PROPOSALS_JSON_SCHEMA,
  type AiProvider,
} from '../src/ai/provider';

// --- node 環境用の localStorage シム ---
class MemStorage {
  private m = new Map<string, string>();
  get length(): number {
    return this.m.size;
  }
  key(i: number): string | null {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, String(v));
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
  clear(): void {
    this.m.clear();
  }
}

// --- @anthropic-ai/sdk のモック（コンストラクタ／messages.stream／typed errors） ---
const h = vi.hoisted(() => {
  const streamOn = vi.fn();
  const finalMessage = vi.fn();
  const streamMock = vi.fn(() => ({ on: streamOn, finalMessage }));
  const ctor = vi.fn(() => ({ messages: { stream: streamMock } }));
  class AuthenticationError extends Error {}
  class RateLimitError extends Error {}
  class APIConnectionError extends Error {}
  class APIError extends Error {}
  return { streamOn, finalMessage, streamMock, ctor, AuthenticationError, RateLimitError, APIConnectionError, APIError };
});
vi.mock('@anthropic-ai/sdk', () => {
  const C = h.ctor as unknown as Record<string, unknown>;
  C.AuthenticationError = h.AuthenticationError;
  C.RateLimitError = h.RateLimitError;
  C.APIConnectionError = h.APIConnectionError;
  C.APIError = h.APIError;
  return { default: h.ctor };
});

// --- fetch レスポンスの最小モック（Response 非依存） ---
function mkRes(status: number, jsonBody: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => jsonBody };
}

const emptyProject = (): Project => ({
  schemaVersion: 1,
  meta: { id: 'p', title: 'テスト', createdAt: '', updatedAt: '', appVersion: '' },
  core: { tasks: {}, dependencies: {}, assignees: {} },
  details: {},
  flow: { byLevel: [] },
  manual: { procedures: {}, assets: {} },
});
const req = () => ({ project: emptyProject(), memo: 'メモ本文', kind: 'batch' as const });

const AZ = { endpoint: 'https://r.openai.azure.com', deployment: 'dep1', apiVersion: '2024-10-21' };
const opsJson = (ops: unknown[]) => JSON.stringify({ operations: ops });

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemStorage();
  h.ctor.mockClear();
  h.streamMock.mockClear();
  h.streamOn.mockClear();
  h.finalMessage.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('requestProposals: オプトインガード（最重要）', () => {
  it('aiEnabled=false で AiError(disabled) を投げ、fetch も SDK コンストラクタも呼ばれない', async () => {
    useUI.getState().setAiEnabled(false);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'disabled' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.ctor).not.toHaveBeenCalled();
    expect(h.streamMock).not.toHaveBeenCalled();
  });

  it('aiEnabled=false は providerOverride 指定時も throw し、override は一切呼ばれない（ガード位置の退行検知）', async () => {
    useUI.getState().setAiEnabled(false);
    const overrideSpy = vi.fn<AiProvider['generateProposals']>();
    const override: AiProvider = { generateProposals: overrideSpy };

    await expect(requestProposals(req(), undefined, override)).rejects.toMatchObject({
      kind: 'disabled',
    });

    expect(overrideSpy).not.toHaveBeenCalled();
  });
});

describe('requestProposals: プロバイダ設定なし（cfg===null）', () => {
  it('API キー未設定（cfg===null）は AiError を投げる', async () => {
    useUI.getState().setAiEnabled(true);
    saveProviderSettings({ kind: 'anthropic' });
    setApiKey('anthropic', '', false); // メモリ・localStorage 双方とも未設定にする（空文字は falsy）

    await expect(requestProposals(req())).rejects.toBeInstanceOf(AiError);
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'unconfigured' });
    expect(h.ctor).not.toHaveBeenCalled();
  });
});

describe('AzureOpenAiProvider（生 fetch）', () => {
  beforeEach(() => {
    useUI.getState().setAiEnabled(true);
    saveProviderSettings({ kind: 'azure-openai', azure: AZ });
    setApiKey('azure-openai', 'AZKEY', false);
  });

  it('URL・api-key ヘッダ・response_format=json_schema を組み立て、返却 JSON が BatchOp[] になる', async () => {
    const content = opsJson([{ op: 'add_task', name: '受注', level: 'medium' }]);
    const fetchSpy = vi.fn(async () => mkRes(200, { choices: [{ message: { content } }] }));
    vi.stubGlobal('fetch', fetchSpy);

    const ops = await requestProposals(req());
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'add_task', name: '受注' });

    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      'https://r.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21',
    );
    expect((init.headers as Record<string, string>)['api-key']).toBe('AZKEY');
    const body = JSON.parse(init.body as string);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.messages[0].role).toBe('system');
    expect(body.messages[1].role).toBe('user');
  });

  it('json_schema が 400 を返したら json_object で 1 回だけ再試行する', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(mkRes(400, { error: 'unsupported' }))
      .mockResolvedValueOnce(mkRes(200, { choices: [{ message: { content: opsJson([]) } }] }));
    vi.stubGlobal('fetch', fetchSpy);

    const ops = await requestProposals(req());
    expect(ops).toEqual([]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(
      (fetchSpy.mock.calls[1] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(secondBody.response_format.type).toBe('json_object');
  });

  it('401 は AiError(auth)、429 は AiError(rateLimit) に写像する', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => mkRes(401, {})));
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'auth' });

    vi.stubGlobal('fetch', vi.fn(async () => mkRes(429, {})));
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'rateLimit' });
  });

  it('不正 JSON（garbage）は AiError(schema）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mkRes(200, { choices: [{ message: { content: 'garbage' } }] })),
    );
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'schema' });
  });
});

describe('AnthropicProvider（公式 SDK・モック）', () => {
  beforeEach(() => {
    useUI.getState().setAiEnabled(true);
    saveProviderSettings({ kind: 'anthropic', model: 'claude-sonnet-5' });
    setApiKey('anthropic', 'ANKEY', false);
  });

  it('messages.stream に model / output_config.format / system / messages を渡し、text を BatchOp[] に通す', async () => {
    h.finalMessage.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: opsJson([{ op: 'add_task', name: 'A', level: 'medium' }]) }],
    });

    const ops = await requestProposals(req());
    expect(ops).toHaveLength(1);

    expect(h.ctor).toHaveBeenCalledWith({ apiKey: 'ANKEY', dangerouslyAllowBrowser: true });
    const calls = h.streamMock.mock.calls as unknown as Array<
      [
        {
          model: string;
          system: string;
          messages: { role: string }[];
          output_config: { format: { type: string } };
          thinking: { type: string };
        },
      ]
    >;
    const params = calls[0]![0];
    expect(params.model).toBe('claude-sonnet-5');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.thinking.type).toBe('adaptive');
    expect(typeof params.system).toBe('string');
    expect(params.messages[0]!.role).toBe('user');
  });

  it('stop_reason=refusal を content より先に検知し AiError(refusal)', async () => {
    h.finalMessage.mockResolvedValueOnce({ stop_reason: 'refusal', content: [] });
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'refusal' });
  });

  it('AuthenticationError は AiError(auth) に写像する', async () => {
    h.finalMessage.mockRejectedValueOnce(new h.AuthenticationError('bad key'));
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'auth' });
  });

  it('RateLimitError は AiError(rateLimit) に写像する', async () => {
    h.finalMessage.mockRejectedValueOnce(new h.RateLimitError('too many requests'));
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'rateLimit' });
  });

  it('APIConnectionError は AiError(connection) に写像する', async () => {
    h.finalMessage.mockRejectedValueOnce(new h.APIConnectionError('network down'));
    await expect(requestProposals(req())).rejects.toMatchObject({ kind: 'connection' });
  });
});

describe('AnthropicProvider: thinking パラメータのモデル別分岐（Important #1）', () => {
  beforeEach(() => {
    useUI.getState().setAiEnabled(true);
    setApiKey('anthropic', 'ANKEY', false);
    h.finalMessage.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: opsJson([]) }],
    });
  });

  function lastStreamParams(): { thinking?: { type: string } } {
    const calls = h.streamMock.mock.calls as unknown as Array<[{ thinking?: { type: string } }]>;
    return calls[calls.length - 1]![0];
  }

  it.each(['claude-opus-4-8', 'claude-sonnet-5'] as const)(
    '%s は thinking: { type: "adaptive" } を含める',
    async (model) => {
      saveProviderSettings({ kind: 'anthropic', model });
      await requestProposals(req());
      expect(lastStreamParams().thinking).toEqual({ type: 'adaptive' });
    },
  );

  it('claude-haiku-4-5 は adaptive thinking 非対応のため thinking パラメータを送らない（省略）', async () => {
    saveProviderSettings({ kind: 'anthropic', model: 'claude-haiku-4-5' });
    await requestProposals(req());
    expect(lastStreamParams().thinking).toBeUndefined();
  });
});

describe('MockAiProvider / providerOverride', () => {
  it('注入した Mock の JSON が BatchOp[] になり、fetch/SDK に到達しない', async () => {
    useUI.getState().setAiEnabled(true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const mock = new MockAiProvider(opsJson([{ op: 'add_task', name: 'X', level: 'large' }]));
    const ops = await requestProposals(req(), undefined, mock);

    expect(ops).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(h.ctor).not.toHaveBeenCalled();
  });
});

describe('B-02: キャンセル / タイムアウト（AbortSignal 引き回し）', () => {
  it('requestProposals は signal を providerOverride の generateProposals へ渡す', async () => {
    useUI.getState().setAiEnabled(true);
    const spy = vi.fn<AiProvider['generateProposals']>(async () => opsJson([]));
    const override: AiProvider = { generateProposals: spy };
    const controller = new AbortController();
    await requestProposals(req(), undefined, override, controller.signal);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![2]).toBe(controller.signal); // 第 3 引数 = signal
  });

  it('Azure は fetch に signal を付与する（AbortSignal.timeout 併用）', async () => {
    useUI.getState().setAiEnabled(true);
    saveProviderSettings({ kind: 'azure-openai', azure: AZ });
    setApiKey('azure-openai', 'AZKEY', false);
    const fetchSpy = vi.fn(async () => mkRes(200, { choices: [{ message: { content: opsJson([]) } }] }));
    vi.stubGlobal('fetch', fetchSpy);

    await requestProposals(req());
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('Anthropic は messages.stream の options に signal を渡す', async () => {
    useUI.getState().setAiEnabled(true);
    saveProviderSettings({ kind: 'anthropic', model: 'claude-sonnet-5' });
    setApiKey('anthropic', 'ANKEY', false);
    h.finalMessage.mockResolvedValueOnce({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: opsJson([]) }],
    });
    const controller = new AbortController();
    await requestProposals(req(), undefined, undefined, controller.signal);
    const call = h.streamMock.mock.calls[0] as unknown as [unknown, { signal?: AbortSignal }];
    expect(call[1]?.signal).toBe(controller.signal);
  });
});

describe('toDisplayError / offersSettings（B-01: エラー文言の握り潰し解消 + 設定導線）', () => {
  it('AiError の具体 message を保持し、AI_ERROR_TEXT[kind] で握り潰さない', () => {
    const specific = 'API に接続できませんでした（HTTP 503）';
    const info = toDisplayError(new AiError('unknown', specific));
    expect(info.text).toBe(specific);
    expect(info.text).not.toBe(AI_ERROR_TEXT.unknown);
    expect(info.kind).toBe('unknown');
  });

  it('未設定案内（cfg===null の具体文言）も保持し、設定導線を出す', () => {
    const msg = 'API キーが未設定です。設定から AI プロバイダのキーを入力してください。';
    const info = toDisplayError(new AiError('unconfigured', msg));
    expect(info.text).toBe(msg);
    expect(info.kind).toBe('unconfigured');
    expect(offersSettings(info.kind)).toBe(true);
  });

  it('AiError でない例外は汎用文言（unknown）へ寄せる', () => {
    const info = toDisplayError(new TypeError('boom'));
    expect(info.text).toBe(AI_ERROR_TEXT.unknown);
    expect(info.kind).toBe('unknown');
  });

  it('offersSettings は auth / disabled / unconfigured に設定導線を出す', () => {
    expect(offersSettings('auth')).toBe(true);
    expect(offersSettings('disabled')).toBe(true);
    expect(offersSettings('unconfigured')).toBe(true);
    expect(offersSettings('rateLimit')).toBe(false);
    expect(offersSettings('connection')).toBe(false);
    expect(offersSettings('schema')).toBe(false);
    expect(offersSettings('refusal')).toBe(false);
    expect(offersSettings('unknown')).toBe(false);
  });
});

describe('PROPOSALS_JSON_SCHEMA と core BatchOpSchema の op 集合の一致（Important #2）', () => {
  it('手書き JSON Schema の op enum は core の BatchOpSchema が持つ op と過不足なく一致する', () => {
    // BatchOpSchema は core 内部で z.discriminatedUnion('op', [...]) だが、公開型は
    // z.ZodType<BatchOp> に広げられている（core の型は変更しない）。実行時には
    // ZodDiscriminatedUnion のままなので optionsMap のキー＝判別に使われる op リテラルの
    // 全集合を、テスト内だけの構造キャストで取り出す。
    const discriminated = BatchOpSchema as unknown as { optionsMap: Map<string, unknown> };
    const coreOps = [...discriminated.optionsMap.keys()].sort();
    const schemaOps = [...PROPOSALS_JSON_SCHEMA.properties.operations.items.properties.op.enum].sort();

    // 双方向: core のみに存在する op も、手書きスキーマのみに存在する op も検知する。
    expect(schemaOps).toEqual(coreOps);
  });
});
