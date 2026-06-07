/**
 * openai-compatible embedding provider + preset 表 + probe 校验测试。
 *
 * 用 vi.spyOn(global, "fetch") mock HTTP 响应,覆盖各种成功 / 失败场景。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OpenAICompatibleEmbeddingProvider,
  createEmbeddingProvider,
  createAndProbeProvider,
  EmbeddingDimMismatchError,
  EMBEDDING_PRESETS,
  getPreset,
  listPresetNames,
} from "../src/loop/embedding/index.js";

// 通用 mock fetch 工厂
function mockFetchResponse(body: unknown, opts: { status?: number; statusText?: string; ok?: boolean } = {}) {
  const status = opts.status ?? 200;
  return Promise.resolve({
    ok: opts.ok ?? status < 400,
    status,
    statusText: opts.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response);
}

describe("OpenAICompatibleEmbeddingProvider — 基础", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("成功响应:返回 embedding 数组", async () => {
    const vec = Array(1024).fill(0).map((_, i) => i / 1024);
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: vec }] }));

    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://api.example.com/v1",
      model: "text-embedding-v3",
      apiKey: "sk-test",
      dim: 1024,
    });
    const result = await p.embed("hello");
    expect(result).toHaveLength(1024);
    expect(result).toEqual(vec);
  });

  it("baseUrl 尾部 / 自动归一化", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: [1, 2, 3] }] }));
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://api.example.com/v1///",
      model: "m",
      dim: 3,
    });
    await p.embed("x");
    expect(fetchSpy).toHaveBeenCalledWith("https://api.example.com/v1/embeddings", expect.anything());
  });

  it("sendDimensions=true 时 HTTP body 带 dimensions 参数", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: [1, 2, 3, 4] }] }));
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      dim: 4,
      sendDimensions: true,
    });
    await p.embed("x");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.dimensions).toBe(4);
  });

  it("sendDimensions=false(默认)时不带 dimensions 参数", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: [1, 2] }] }));
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      dim: 2,
    });
    await p.embed("x");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.dimensions).toBeUndefined();
  });

  it("apiKey 设了 → Authorization header 带", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: [1] }] }));
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      dim: 1,
      apiKey: "sk-test-key",
    });
    await p.embed("x");
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-test-key" });
  });

  it("apiKey 没设(Ollama 本地)→ 无 Authorization header", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: [1] }] }));
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "http://localhost:11434/v1",
      model: "nomic-embed-text",
      dim: 1,
    });
    await p.embed("x");
    const [, init] = fetchSpy.mock.calls[0];
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it("batch 模式:input 是数组", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({
      data: [{ embedding: [1, 2] }, { embedding: [3, 4] }],
    }));
    const p = new OpenAICompatibleEmbeddingProvider({
      baseUrl: "https://api.example.com/v1",
      model: "m",
      dim: 2,
    });
    const result = await p.embedBatch(["a", "b"]);
    expect(result).toEqual([[1, 2], [3, 4]]);
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.input).toEqual(["a", "b"]);
  });

  it("单条 embed 时 input 是 string(非 array)", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: [1] }] }));
    const p = new OpenAICompatibleEmbeddingProvider({ baseUrl: "x", model: "m", dim: 1 });
    await p.embed("hello");
    const [, init] = fetchSpy.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(typeof body.input).toBe("string");
    expect(body.input).toBe("hello");
  });
});

describe("OpenAICompatibleEmbeddingProvider — 错误处理", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("HTTP 401 → 抛错(含状态码 + body)", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ error: { message: "invalid api key" } }, { status: 401, statusText: "Unauthorized", ok: false }));
    const p = new OpenAICompatibleEmbeddingProvider({ baseUrl: "x", model: "m", dim: 1, apiKey: "bad" });
    await expect(p.embed("x")).rejects.toThrow(/HTTP 401/);
    await expect(p.embed("x")).rejects.toThrow(/invalid api key/);
  });

  it("HTTP 429 → 抛错(rate limit)", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ error: "quota" }, { status: 429, ok: false }));
    const p = new OpenAICompatibleEmbeddingProvider({ baseUrl: "x", model: "m", dim: 1 });
    await expect(p.embed("x")).rejects.toThrow(/HTTP 429/);
  });

  it("响应缺少 data 数组 → 抛错", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ wrong: "format" }));
    const p = new OpenAICompatibleEmbeddingProvider({ baseUrl: "x", model: "m", dim: 1 });
    await expect(p.embed("x")).rejects.toThrow(/missing "data" array/);
  });

  it("data 项缺 embedding 字段 → 抛错", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ wrong: 1 }] }));
    const p = new OpenAICompatibleEmbeddingProvider({ baseUrl: "x", model: "m", dim: 1 });
    await expect(p.embed("x")).rejects.toThrow(/missing "embedding" array/);
  });

  it("embedding 含非数字 → 抛错", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: [1, "not-a-number", 3] }] }));
    const p = new OpenAICompatibleEmbeddingProvider({ baseUrl: "x", model: "m", dim: 3 });
    await expect(p.embed("x")).rejects.toThrow(/non-numeric/);
  });

  it("网络错误 → 抛错", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    const p = new OpenAICompatibleEmbeddingProvider({ baseUrl: "x", model: "m", dim: 1 });
    await expect(p.embed("x")).rejects.toThrow(/network error/);
  });
});

describe("preset 表", () => {
  it("包含核心 6 个 preset", () => {
    const names = listPresetNames();
    expect(names).toContain("dashscope-v3");
    expect(names).toContain("zhipu-3");
    expect(names).toContain("openai-3-small");
    expect(names).toContain("openai-3-large");
    expect(names).toContain("ollama-nomic");
    expect(names).toContain("ollama-bge-m3");
  });

  it("每个 preset 都有 baseUrl / model / dim / requiresKey / description", () => {
    for (const name of listPresetNames()) {
      const p = getPreset(name)!;
      expect(p.baseUrl).toBeTruthy();
      expect(p.model).toBeTruthy();
      expect(p.dim).toBeGreaterThan(0);
      expect(typeof p.requiresKey).toBe("boolean");
      expect(p.description).toBeTruthy();
    }
  });

  it("Ollama presets requiresKey=false", () => {
    expect(EMBEDDING_PRESETS["ollama-nomic"].requiresKey).toBe(false);
    expect(EMBEDDING_PRESETS["ollama-bge-m3"].requiresKey).toBe(false);
  });

  it("云服务 preset requiresKey=true", () => {
    expect(EMBEDDING_PRESETS["dashscope-v3"].requiresKey).toBe(true);
    expect(EMBEDDING_PRESETS["openai-3-small"].requiresKey).toBe(true);
  });

  it("dim 值符合厂商官方说明", () => {
    expect(EMBEDDING_PRESETS["dashscope-v3"].dim).toBe(1024);
    expect(EMBEDDING_PRESETS["openai-3-small"].dim).toBe(1536);
    expect(EMBEDDING_PRESETS["openai-3-large"].dim).toBe(3072);
    expect(EMBEDDING_PRESETS["ollama-nomic"].dim).toBe(768);
  });
});

describe("createEmbeddingProvider — preset 解析", () => {
  it("默认(空 config)→ hash-bag", () => {
    const p = createEmbeddingProvider();
    expect(p.id).toMatch(/^hash-bag/);
  });

  it("preset='dashscope-v3' + apiKey → openai-compatible w/ preset 默认", () => {
    const p = createEmbeddingProvider({ preset: "dashscope-v3", apiKey: "sk-test" });
    expect(p.id).toMatch(/^openai-compat/);
    expect(p.dim).toBe(1024);
  });

  it("preset 缺 apiKey 时抛错(requiresKey=true)", () => {
    expect(() => createEmbeddingProvider({ preset: "dashscope-v3" })).toThrow(/requires apiKey/);
  });

  it("Ollama preset 不需要 apiKey", () => {
    const p = createEmbeddingProvider({ preset: "ollama-nomic" });
    expect(p.id).toMatch(/^openai-compat/);
    expect(p.dim).toBe(768);
  });

  it("用户 dim 覆盖 preset 默认", () => {
    const p = createEmbeddingProvider({ preset: "dashscope-v3", apiKey: "k", dim: 512 });
    expect(p.dim).toBe(512);
  });

  it("用户 model 覆盖 preset 默认", () => {
    const p = createEmbeddingProvider({
      preset: "openai-3-small",
      apiKey: "k",
      model: "text-embedding-3-large",
    });
    // model 覆盖反映在 id 上
    expect(p.id).toContain("text-embedding-3-large");
  });

  it("未知 preset → 抛错 + 列出可用", () => {
    expect(() => createEmbeddingProvider({ preset: "nonexistent" })).toThrow(/Unknown embedding preset/);
    expect(() => createEmbeddingProvider({ preset: "nonexistent" })).toThrow(/dashscope-v3/);
  });

  it("provider='openai-compatible' 手动配置(无 preset)", () => {
    const p = createEmbeddingProvider({
      provider: "openai-compatible",
      baseUrl: "https://custom/v1",
      model: "my-embed",
      dim: 1024,
      apiKey: "k",
    });
    expect(p.id).toMatch(/^openai-compat/);
    expect(p.dim).toBe(1024);
  });

  it("openai-compatible 缺 baseUrl/model/dim 抛错", () => {
    expect(() => createEmbeddingProvider({ provider: "openai-compatible", model: "m", dim: 1 })).toThrow(/missing baseUrl/);
    expect(() => createEmbeddingProvider({ provider: "openai-compatible", baseUrl: "x", dim: 1 })).toThrow(/missing model/);
    expect(() => createEmbeddingProvider({ provider: "openai-compatible", baseUrl: "x", model: "m" })).toThrow(/missing dim/);
  });
});

describe("createAndProbeProvider — probe 校验", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    fetchSpy = vi.spyOn(global, "fetch");
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("hash-bag 跳过 probe(不发 HTTP)", async () => {
    const p = await createAndProbeProvider({});
    expect(p.id).toMatch(/^hash-bag/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("openai-compat dim 匹配 → 返回 provider", async () => {
    const vec = Array(1024).fill(0.5);
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: vec }] }));
    const p = await createAndProbeProvider({
      preset: "dashscope-v3",
      apiKey: "k",
    });
    expect(p.dim).toBe(1024);
  });

  it("dim 不匹配 → 抛 EmbeddingDimMismatchError(含实际 vs 配置)", async () => {
    const vec = Array(512).fill(0); // 模型实际返回 512
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: vec }] }));
    await expect(
      createAndProbeProvider({ preset: "dashscope-v3", apiKey: "k" }), // 配置 1024
    ).rejects.toThrow(EmbeddingDimMismatchError);
    try {
      await createAndProbeProvider({ preset: "dashscope-v3", apiKey: "k" });
    } catch (err) {
      const e = err as EmbeddingDimMismatchError;
      expect(e.configured).toBe(1024);
      expect(e.actual).toBe(512);
    }
  });

  it("dim 不匹配错误信息含修复提示", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ data: [{ embedding: Array(512).fill(0) }] }));
    await expect(
      createAndProbeProvider({ preset: "dashscope-v3", apiKey: "k" }),
    ).rejects.toThrow(/Fix by setting settings\.memory\.embedding\.dim to 512/);
  });

  it("网络错误 → 抛原始错误(不是 dim mismatch)", async () => {
    fetchSpy.mockImplementation(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(
      createAndProbeProvider({ preset: "ollama-nomic" }),
    ).rejects.toThrow(/network error/);
  });

  it("401 → 抛 HTTP 401(不是 dim mismatch)", async () => {
    fetchSpy.mockReturnValue(mockFetchResponse({ error: "bad key" }, { status: 401, ok: false }));
    await expect(
      createAndProbeProvider({ preset: "dashscope-v3", apiKey: "wrong" }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
