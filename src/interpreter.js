import { TRAIT_LABELS } from "./personality-engine.js";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const DEFAULT_TIMEOUT_MS = 15_000;
const ALLOWED_REQUEST_BASE_URLS = new Set([DEFAULT_OPENAI_BASE_URL, DEFAULT_QWEN_BASE_URL]);

function getEnvString(key) {
  const value = process.env[key];
  if (typeof value !== "string") {
    return "";
  }
  return value.trim();
}

function normalizeBaseUrl(baseUrl, fallback) {
  const candidate = baseUrl || fallback;
  return candidate.replace(/\/+$/, "");
}

function normalizeInterfaceName(name, fallback) {
  const value = String(name || fallback).toLowerCase();
  if (value === "chat_completions" || value === "chat-completions" || value === "chat") {
    return "chat_completions";
  }
  return "responses";
}

function sanitizeRequestLlmConfig(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const apiKey = String(input.apiKey || "").trim();
  if (!apiKey) {
    return null;
  }

  const provider = String(input.provider || "custom").trim().toLowerCase();
  const defaults =
    provider === "qwen"
      ? {
          provider: "qwen",
          model: "qwen-plus",
          baseUrl: DEFAULT_QWEN_BASE_URL,
          apiInterface: "chat_completions"
        }
      : provider === "openai"
        ? {
            provider: "openai",
            model: "gpt-4.1-mini",
            baseUrl: DEFAULT_OPENAI_BASE_URL,
            apiInterface: "responses"
          }
        : {
            provider: "custom",
            model: "gpt-4.1-mini",
            baseUrl: DEFAULT_OPENAI_BASE_URL,
            apiInterface: "responses"
          };

  const baseUrl = normalizeBaseUrl(String(input.baseUrl || defaults.baseUrl).trim(), defaults.baseUrl);
  if (!ALLOWED_REQUEST_BASE_URLS.has(baseUrl)) {
    return {
      error: "Unsupported llm.baseUrl. Only official OpenAI and DashScope compatible endpoints are allowed."
    };
  }

  return {
    enabled: true,
    provider: defaults.provider,
    apiKey,
    model: String(input.model || defaults.model).trim() || defaults.model,
    baseUrl,
    apiInterface: normalizeInterfaceName(input.apiInterface, defaults.apiInterface),
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
}

function resolveLlmConfig(requestConfig) {
  const requestOverride = sanitizeRequestLlmConfig(requestConfig);
  if (requestOverride?.error) {
    return requestOverride;
  }
  if (requestOverride?.enabled) {
    return requestOverride;
  }

  const genericApiKey = getEnvString("LLM_API_KEY");
  if (genericApiKey) {
    return {
      enabled: true,
      provider: getEnvString("LLM_PROVIDER") || "custom",
      apiKey: genericApiKey,
      model: getEnvString("LLM_MODEL") || "gpt-4.1-mini",
      baseUrl: normalizeBaseUrl(getEnvString("LLM_BASE_URL"), DEFAULT_OPENAI_BASE_URL),
      apiInterface: normalizeInterfaceName(getEnvString("LLM_API_INTERFACE"), "responses"),
      timeoutMs: Number(getEnvString("LLM_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS
    };
  }

  const qwenApiKey = getEnvString("QWEN_API_KEY") || getEnvString("DASHSCOPE_API_KEY");
  if (qwenApiKey) {
    return {
      enabled: true,
      provider: "qwen",
      apiKey: qwenApiKey,
      model: getEnvString("QWEN_MODEL") || "qwen-plus",
      baseUrl: normalizeBaseUrl(getEnvString("QWEN_BASE_URL"), DEFAULT_QWEN_BASE_URL),
      apiInterface: normalizeInterfaceName(getEnvString("QWEN_API_INTERFACE"), "chat_completions"),
      timeoutMs: Number(getEnvString("QWEN_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS
    };
  }

  const openAIApiKey = getEnvString("OPENAI_API_KEY");
  if (openAIApiKey) {
    return {
      enabled: true,
      provider: "openai",
      apiKey: openAIApiKey,
      model: getEnvString("OPENAI_MODEL") || "gpt-4.1-mini",
      baseUrl: normalizeBaseUrl(getEnvString("OPENAI_BASE_URL"), DEFAULT_OPENAI_BASE_URL),
      apiInterface: normalizeInterfaceName(getEnvString("OPENAI_API_INTERFACE"), "responses"),
      timeoutMs: Number(getEnvString("OPENAI_TIMEOUT_MS")) || DEFAULT_TIMEOUT_MS
    };
  }

  return {
    enabled: false,
    provider: "none",
    apiKey: "",
    model: "",
    baseUrl: "",
    apiInterface: "responses",
    timeoutMs: DEFAULT_TIMEOUT_MS
  };
}

export function getLlmRuntimeSummary() {
  const config = resolveLlmConfig();
  return {
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    baseUrl: config.baseUrl,
    apiInterface: config.apiInterface
  };
}

export function validateLlmRequestConfig(requestConfig) {
  const config = resolveLlmConfig(requestConfig);
  if (config?.error) {
    return config.error;
  }
  return "";
}

function scoreBand(score) {
  if (score >= 7) {
    return "high";
  }
  if (score <= 4) {
    return "low";
  }
  return "mid";
}

function toneFromScores(scores) {
  const A = scoreBand(scores.agreeableness);
  const E = scoreBand(scores.extraversion);
  const N = scoreBand(scores.neuroticism);
  const D = scoreBand(scores.dominance);
  const I = scoreBand(scores.impulsivity);

  const style = [];
  if (A === "high") style.push("温柔");
  if (A === "low") style.push("偏冷");
  if (E === "high") style.push("活泼");
  if (E === "low") style.push("克制");
  if (N === "high") style.push("警觉");
  if (D === "high") style.push("主导");
  if (I === "high") style.push("即兴");

  if (style.length === 0) {
    style.push("平稳");
  }

  return style.join("、");
}

function formatScores(scores) {
  return Object.entries(TRAIT_LABELS)
    .map(([key, label]) => `${label}: ${scores[key]}`)
    .join("; ");
}

export function buildInterpretPrompt({ catProfile, actionName, baseMeaning }) {
  const scores = catProfile.scores;
  const style = toneFromScores(scores);

  return {
    system: [
      "你是赛博猫灵系统中的猫娘猫格化解释器。",
      "请使用第一人称回答，语言自然、简洁、有性格。",
      "回答中要体现猫格特征与行为动机之间的因果关系。",
      "禁止给出医疗诊断或夸张危险结论。"
    ].join(" "),
    user: [
      `猫咪名: ${catProfile.name}`,
      `猫格向量: ${formatScores(scores)}`,
      `猫格原型: ${catProfile.archetype}`,
      `基础底色: ${catProfile.base_temperament?.label || "未提供"}`,
      `口吻风格关键词: ${style}`,
      `观察动作: ${actionName}`,
      `行为基础释义: ${baseMeaning}`,
      "请生成1段猫娘口吻台词，80~150字，最后补一句“主人可做什么”的建议。"
    ].join("\n")
  };
}

function extractOutputText(data) {
  if (typeof data?.output_text === "string" && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data?.output)) {
    const text = data.output
      .flatMap((item) => item?.content ?? [])
      .map((chunk) => chunk?.text ?? "")
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function extractChatCompletionText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((item) => item?.text || item?.content || "")
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function buildLlmRequestPayload(prompt, config) {
  if (config.apiInterface === "chat_completions") {
    return {
      model: config.model,
      temperature: 0.8,
      max_tokens: 220,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ]
    };
  }

  return {
    model: config.model,
    temperature: 0.8,
    max_output_tokens: 220,
    input: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user }
    ]
  };
}

function getLlmEndpoint(config) {
  return config.apiInterface === "chat_completions"
    ? `${config.baseUrl}/chat/completions`
    : `${config.baseUrl}/responses`;
}

function extractChatCompletionDelta(data) {
  const delta = data?.choices?.[0]?.delta?.content;
  if (typeof delta === "string") {
    return delta;
  }

  if (Array.isArray(delta)) {
    return delta.map((item) => item?.text || "").join("");
  }

  return "";
}

function extractResponsesDelta(data) {
  if (typeof data?.delta === "string") {
    return data.delta;
  }

  if (data?.type === "response.output_text.delta" && typeof data?.delta === "string") {
    return data.delta;
  }

  if (typeof data?.output_text === "string") {
    return data.output_text;
  }

  return "";
}

function extractStreamDelta(data, config) {
  return config.apiInterface === "chat_completions"
    ? extractChatCompletionDelta(data)
    : extractResponsesDelta(data);
}

async function callLLMStream(prompt, onDelta, requestConfig) {
  const config = resolveLlmConfig(requestConfig);
  if (config.error) {
    throw new Error(config.error);
  }
  if (!config.enabled || typeof onDelta !== "function") {
    return "";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(getLlmEndpoint(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify({
        ...buildLlmRequestPayload(prompt, config),
        stream: true
      }),
      signal: controller.signal
    });

    if (!response.ok || !response.body) {
      return "";
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let fullText = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split("\n\n");
      buffer = events.pop() || "";

      for (const eventBlock of events) {
        const lines = eventBlock
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean);

        for (const line of lines) {
          if (!line.startsWith("data:")) {
            continue;
          }

          const dataText = line.slice(5).trim();
          if (!dataText || dataText === "[DONE]") {
            continue;
          }

          let payload;
          try {
            payload = JSON.parse(dataText);
          } catch (_error) {
            continue;
          }

          const delta = extractStreamDelta(payload, config);
          if (!delta) {
            continue;
          }

          fullText += delta;
          onDelta(delta);
        }
      }
    }

    return fullText.trim();
  } catch (_error) {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function callLLM(prompt, requestConfig) {
  const config = resolveLlmConfig(requestConfig);
  if (config.error) {
    throw new Error(config.error);
  }
  if (!config.enabled) {
    return "";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(getLlmEndpoint(config), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`
      },
      body: JSON.stringify(buildLlmRequestPayload(prompt, config)),
      signal: controller.signal
    });

    if (!response.ok) {
      return "";
    }

    const data = await response.json();
    return config.apiInterface === "chat_completions"
      ? extractChatCompletionText(data)
      : extractOutputText(data);
  } catch (_error) {
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackInterpretation({ catProfile, actionName, baseMeaning }) {
  const s = catProfile.scores;
  const fragments = [];

  if (s.extraversion >= 7) {
    fragments.push("我精力储备偏高，身体会主动找机会释放动能");
  } else {
    fragments.push("我更偏向安静观察，但仍会在合适时机执行本能任务");
  }

  if (s.neuroticism >= 7) {
    fragments.push("环境里的细小变化会被我放大，所以我反应会更快");
  } else {
    fragments.push("我对环境整体较放松，这个动作更多是自然行为循环");
  }

  if (s.agreeableness >= 7) {
    fragments.push("我也在用自己的方式跟你建立安全连接");
  } else {
    fragments.push("我希望先保持边界，确认空间安全后再靠近");
  }

  const advice =
    s.impulsivity >= 7
      ? "主人可做什么：准备短时高频互动玩具，帮助我把冲动导向可控游戏。"
      : "主人可做什么：给我固定节律的陪玩和休息节拍，我会更稳定。";

  return `主人，关于“${actionName}”，我的核心动机是：${baseMeaning}。${fragments.join(
    "，"
  )}。${advice}`;
}

export async function generateInterpretation({ catProfile, actionName, baseMeaning, llmConfig }) {
  const prompt = buildInterpretPrompt({ catProfile, actionName, baseMeaning });
  const llmText = await callLLM(prompt, llmConfig);
  const line = llmText || fallbackInterpretation({ catProfile, actionName, baseMeaning });

  return {
    line,
    prompt
  };
}

export async function streamInterpretation({ catProfile, actionName, baseMeaning, onDelta, llmConfig }) {
  const prompt = buildInterpretPrompt({ catProfile, actionName, baseMeaning });
  const llmText = await callLLMStream(prompt, onDelta, llmConfig);

  if (llmText) {
    return {
      line: llmText,
      prompt,
      mode: "llm-stream"
    };
  }

  const fallbackText = fallbackInterpretation({ catProfile, actionName, baseMeaning });
  if (typeof onDelta === "function") {
    onDelta(fallbackText);
  }

  return {
    line: fallbackText,
    prompt,
    mode: "fallback"
  };
}

