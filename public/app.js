const TRAITS = [
  { key: "neuroticism", label: "神经质" },
  { key: "extraversion", label: "外向性" },
  { key: "dominance", label: "支配欲" },
  { key: "impulsivity", label: "冲动性" },
  { key: "agreeableness", label: "宜人性" }
];

const RADAR_THEME = {
  ringStroke: "#f5b9d1",
  axisStroke: "#ebb1c8",
  polygonFill: "#ff8eb74d",
  polygonStroke: "#f8649f",
  centerFill: "#f8649f"
};

const assessmentForm = document.querySelector("#assessment-form");
const interpretForm = document.querySelector("#interpret-form");

const questionnaireList = document.querySelector("#questionnaire-list");
const experimentList = document.querySelector("#experiment-list");
const temperamentView = document.querySelector("#temperament-view");
const actionSelect = document.querySelector("#action-select");
const customActionInput = document.querySelector("#custom-action");
const outputNode = document.querySelector("#interpret-output");
const radarNode = document.querySelector("#radar");
const personaImageDock = document.querySelector("#persona-image-dock");
const llmProviderSelect = document.querySelector("#llm-provider");
const llmInterfaceSelect = document.querySelector("#llm-interface");
const llmModelInput = document.querySelector("#llm-model");
const llmBaseUrlInput = document.querySelector("#llm-base-url");
const llmApiKeyInput = document.querySelector("#llm-api-key");
const llmConfigHint = document.querySelector("#llm-config-hint");

const DEFAULT_WEIGHTING = {
  questionnaire: 0.7,
  experiment: 0.3
};

const LLM_SESSION_KEY = "cyber-cat-spirit-llm-config";
const PROVIDER_DEFAULTS = {
  openai: {
    model: "gpt-4.1-mini",
    baseUrl: "https://api.openai.com/v1",
    apiInterface: "responses"
  },
  qwen: {
    model: "qwen-plus",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    apiInterface: "chat_completions"
  },
  custom: {
    model: "",
    baseUrl: "",
    apiInterface: "responses"
  }
};

let currentProfile = null;
let currentAssessment = null;
let questionnaireItems = [];
let experimentItems = [];
let personaImageItems = [];
let interpretationStreamController = null;

function getProviderDefaults(provider) {
  return PROVIDER_DEFAULTS[provider] || PROVIDER_DEFAULTS.openai;
}

function readLlmFormState() {
  const provider = llmProviderSelect?.value || "openai";
  return {
    provider,
    apiInterface: llmInterfaceSelect?.value || getProviderDefaults(provider).apiInterface,
    model: llmModelInput?.value.trim() || "",
    baseUrl: llmBaseUrlInput?.value.trim() || "",
    apiKey: llmApiKeyInput?.value.trim() || ""
  };
}

function saveLlmFormState() {
  if (!window.sessionStorage) {
    return;
  }

  window.sessionStorage.setItem(LLM_SESSION_KEY, JSON.stringify(readLlmFormState()));
}

function setLlmConfigHint(text) {
  if (llmConfigHint) {
    llmConfigHint.textContent = text;
  }
}

function applyProviderDefaults(provider, { force = false } = {}) {
  const defaults = getProviderDefaults(provider);
  if (!llmInterfaceSelect || !llmModelInput || !llmBaseUrlInput) {
    return;
  }

  if (force || !llmModelInput.value.trim()) {
    llmModelInput.value = defaults.model;
  }

  if (force || !llmBaseUrlInput.value.trim()) {
    llmBaseUrlInput.value = defaults.baseUrl;
  }

  if (force || !llmInterfaceSelect.value.trim()) {
    llmInterfaceSelect.value = defaults.apiInterface;
  } else if (force) {
    llmInterfaceSelect.value = defaults.apiInterface;
  }
}

function refreshLlmHint() {
  const { provider, apiKey, baseUrl } = readLlmFormState();
  if (!apiKey) {
    setLlmConfigHint("当前未填写 API Key，本次解释会回退到服务器默认配置或本地模板。");
    return;
  }

  if (provider === "custom") {
    setLlmConfigHint(`当前将使用自定义兼容接口：${baseUrl || "未填写 Base URL"}`);
    return;
  }

  setLlmConfigHint(`当前将优先使用你填写的 ${provider} 配置。`);
}

function restoreLlmFormState() {
  const fallback = {
    provider: "openai",
    ...PROVIDER_DEFAULTS.openai
  };
  let saved = fallback;

  if (window.sessionStorage) {
    try {
      saved = {
        ...fallback,
        ...JSON.parse(window.sessionStorage.getItem(LLM_SESSION_KEY) || "{}")
      };
    } catch (_error) {
      saved = fallback;
    }
  }

  if (llmProviderSelect) {
    llmProviderSelect.value = saved.provider || "openai";
  }
  applyProviderDefaults(llmProviderSelect?.value || "openai", { force: true });

  if (llmInterfaceSelect && saved.apiInterface) {
    llmInterfaceSelect.value = saved.apiInterface;
  }
  if (llmModelInput) {
    llmModelInput.value = saved.model || llmModelInput.value;
  }
  if (llmBaseUrlInput) {
    llmBaseUrlInput.value = saved.baseUrl || llmBaseUrlInput.value;
  }
  if (llmApiKeyInput) {
    llmApiKeyInput.value = saved.apiKey || "";
  }

  refreshLlmHint();
}

function bindLlmConfigForm() {
  const inputs = [
    llmProviderSelect,
    llmInterfaceSelect,
    llmModelInput,
    llmBaseUrlInput,
    llmApiKeyInput
  ].filter(Boolean);

  if (llmProviderSelect) {
    llmProviderSelect.addEventListener("change", () => {
      applyProviderDefaults(llmProviderSelect.value, { force: true });
      refreshLlmHint();
      saveLlmFormState();
    });
  }

  for (const input of inputs) {
    input.addEventListener("input", () => {
      refreshLlmHint();
      saveLlmFormState();
    });
    input.addEventListener("change", saveLlmFormState);
  }
}

function buildLlmPayload() {
  const config = readLlmFormState();
  if (!config.apiKey) {
    return null;
  }

  return {
    provider: config.provider,
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    apiInterface: config.apiInterface
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function abortInterpretationStream() {
  if (interpretationStreamController) {
    interpretationStreamController.abort();
    interpretationStreamController = null;
  }
}

function bindPersonaImageState() {
  if (!personaImageDock) {
    return;
  }

  const images = personaImageDock.querySelectorAll("img[data-persona-image]");
  for (const imageNode of images) {
    const thumbNode = imageNode.closest(".persona-thumb");
    if (!thumbNode) {
      continue;
    }

    const markLoaded = () => thumbNode.classList.add("is-loaded");
    const markError = () => {
      thumbNode.classList.remove("is-loaded");
      imageNode.remove();
    };

    if (imageNode.complete) {
      if (imageNode.naturalWidth > 0) {
        markLoaded();
      } else {
        markError();
      }
      continue;
    }

    imageNode.addEventListener("load", markLoaded, { once: true });
    imageNode.addEventListener("error", markError, { once: true });
  }
}

function renderPersonaImageDock(activePersona = null) {
  if (!personaImageDock) {
    return;
  }

  personaImageDock.classList.remove("single");

  const activePersonaCode =
    typeof activePersona === "string" ? activePersona : String(activePersona?.code || "");
  const activeQuote =
    activePersona && typeof activePersona === "object"
      ? String(activePersona.quote || "").trim()
      : "";

  if (!Array.isArray(personaImageItems) || personaImageItems.length === 0) {
    personaImageDock.innerHTML =
      '<p class="persona-image-empty">猫格图片接口已就绪，待你上传图片后会自动显示在这里。</p>';
    return;
  }

  if (!activePersonaCode) {
    personaImageDock.innerHTML =
      '<p class="persona-image-empty">生成猫格后，这里只会展示当前匹配的猫格形象。</p>';
    return;
  }

  const activeItem = personaImageItems.find(
    (item) => String(item.code || "") === activePersonaCode
  );

  if (!activeItem) {
    personaImageDock.innerHTML =
      '<p class="persona-image-empty">未找到该猫格对应图片，请检查图片命名或映射配置。</p>';
    return;
  }

  const code = String(activeItem.code || "");
  const label = activeItem.label || code || "未命名";
  const labelEn = String(activeItem.label_en || "");
  const imageUrl = String(activeItem.image_url || "").trim();
  const quoteHint = activeQuote ? `猫格语录：${activeQuote}` : "";
  const tooltip = quoteHint ? ` title="${escapeHtml(quoteHint)}"` : "";
  const imageTag = imageUrl
    ? `<img data-persona-image="1" src="${escapeHtml(imageUrl)}" alt="${escapeHtml(label)}" loading="lazy" />`
    : "";

  personaImageDock.classList.add("single");
  personaImageDock.innerHTML = `
    <article class="persona-card is-active" data-persona-code="${escapeHtml(code)}">
      <div class="persona-thumb${imageUrl ? " has-image" : ""}"${tooltip}>
        ${imageTag}
        <span class="persona-placeholder">${escapeHtml(label)}</span>
      </div>
      <p class="persona-name">
        ${escapeHtml(label)}
        ${labelEn ? `<span>${escapeHtml(labelEn)}</span>` : ""}
      </p>
    </article>
  `;

  bindPersonaImageState();
}

function radarPoint(cx, cy, radius, index, total, value = 10) {
  const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
  const r = radius * (value / 10);
  return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
}

function renderRadar(profile) {
  const scores = TRAITS.map((item) => ({
    ...item,
    score: Number(profile.scores[item.key] || 0)
  }));
  const cx = 200;
  const cy = 170;
  const radius = 120;
  const rings = [2, 4, 6, 8, 10];

  const ringPolygons = rings
    .map((ring) => {
      const points = scores
        .map((_, i) => radarPoint(cx, cy, radius, i, scores.length, ring))
        .map((p) => `${p.x},${p.y}`)
        .join(" ");
      return `<polygon points="${points}" fill="none" stroke="${RADAR_THEME.ringStroke}" stroke-width="1" />`;
    })
    .join("");

  const axes = scores
    .map((item, i) => {
      const edge = radarPoint(cx, cy, radius, i, scores.length, 10);
      const labelPoint = radarPoint(cx, cy, radius + 24, i, scores.length, 10);
      return `
        <line x1="${cx}" y1="${cy}" x2="${edge.x}" y2="${edge.y}" stroke="${RADAR_THEME.axisStroke}" />
        <text x="${labelPoint.x}" y="${labelPoint.y}" text-anchor="middle">${item.label}</text>
      `;
    })
    .join("");

  const scorePolygon = scores
    .map((item, i) => radarPoint(cx, cy, radius, i, scores.length, item.score))
    .map((point) => `${point.x},${point.y}`)
    .join(" ");

  radarNode.innerHTML = `
    ${ringPolygons}
    ${axes}
    <polygon
      points="${scorePolygon}"
      fill="${RADAR_THEME.polygonFill}"
      stroke="${RADAR_THEME.polygonStroke}"
      stroke-width="2"
    />
    <circle cx="${cx}" cy="${cy}" r="3.5" fill="${RADAR_THEME.centerFill}" />
  `;
}

function renderQuestionnaire(items) {
  questionnaireList.innerHTML = items
    .map(
      (item, index) => `
      <article class="qa-card">
        <h3>Q${index + 1}. ${item.text}</h3>
        <div class="qa-options">
          ${item.options
          .map(
            (option) => `
              <label class="choice">
                <input type="radio" name="question-${item.id}" value="${option.id}" required />
                <span>${option.text}</span>
              </label>
            `
          )
          .join("")}
        </div>
      </article>
    `
    )
    .join("");
}

function renderExperiments(items) {
  experimentList.innerHTML = items
    .map(
      (item, index) => `
      <article class="qa-card">
        <h3>实验 ${index + 1}. ${item.title}</h3>
        <p class="instruction">${item.instruction}</p>
        <div class="qa-options">
          ${item.outcomes
          .map(
            (outcome) => `
              <label class="choice">
                <input type="radio" name="experiment-${item.id}" value="${outcome.id}" />
                <span>${outcome.text}</span>
              </label>
            `
          )
          .join("")}
        </div>
      </article>
    `
    )
    .join("");
}

function collectQuestionnaireAnswers() {
  return questionnaireItems
    .map((item) => {
      const selected = document.querySelector(`input[name="question-${item.id}"]:checked`);
      return selected ? { questionId: item.id, optionId: selected.value } : null;
    })
    .filter(Boolean);
}

function collectExperimentAnswers() {
  return experimentItems
    .map((item) => {
      const selected = document.querySelector(`input[name="experiment-${item.id}"]:checked`);
      return selected ? { experimentId: item.id, outcomeId: selected.value } : null;
    })
    .filter(Boolean);
}

function renderAssessmentSummary(assessment) {
  const t = assessment.base_temperament;
  const anime = assessment.anime_persona;
  const doneQ = assessment.score_debug.questionnaire_answered;
  const doneE = assessment.score_debug.experiment_answered;
  const coreTraits = Array.isArray(anime?.core_traits) ? anime.core_traits.join("、") : "无";
  const portraitText = String(anime?.portrait_text || "").trim();
  const quoteText = String(anime?.quote || "").trim();

  temperamentView.innerHTML = `
    <div class="result-block">
      <strong>基础性格底色</strong>
      <p>${escapeHtml(t.label)}（${escapeHtml(t.description)}）</p>
    </div>
    <div class="result-block">
      <strong>最终猫格标签</strong>
      <p>${escapeHtml(anime?.label || "未判定")}${anime?.label_en ? `（${escapeHtml(anime.label_en)}）` : ""}</p>
    </div>
    <div class="result-block">
      <strong>核心特质</strong>
      <p>${escapeHtml(coreTraits)}</p>
    </div>
    ${portraitText ? `<div class="result-block"><p>${escapeHtml(portraitText)}</p></div>` : ""}
    <div class="result-block">
      <strong>猫格语录</strong>
      <p>${quoteText ? `“${escapeHtml(quoteText)}”` : "—"}</p>
    </div>
    <div class="result-block result-meta">
      <strong>完成度</strong>
      <p>完成度：问卷 ${doneQ}/10，实验 ${doneE}/2</p>
    </div>
  `;
}

async function loadAssessmentConfig() {
  const [questionnaireRes, experimentRes, personaImageRes] = await Promise.all([
    fetch("/api/personality/questionnaire"),
    fetch("/api/personality/experiments"),
    fetch("/api/personality/persona-images")
  ]);
  const questionnaire = await questionnaireRes.json();
  const experiments = await experimentRes.json();
  const personaImages = await personaImageRes.json();

  questionnaireItems = questionnaire.items || [];
  experimentItems = experiments.items || [];
  personaImageItems = personaImages.items || [];

  renderQuestionnaire(questionnaireItems);
  renderExperiments(experimentItems);
  renderPersonaImageDock();
}

async function loadBehaviors() {
  const response = await fetch("/api/behaviors");
  const data = await response.json();
  actionSelect.innerHTML = data.items
    .map((item) => `<option value="${item.action_id}">${item.action_name}</option>`)
    .join("");
}

async function generateProfile(event) {
  event.preventDefault();

  const questionnaireAnswers = collectQuestionnaireAnswers();
  if (questionnaireAnswers.length < questionnaireItems.length) {
    outputNode.textContent = "请先完成全部 10 道问卷，再生成猫格。";
    return;
  }

  const payload = {
    catName: document.querySelector("#cat-name").value.trim() || "Mocha",
    questionnaireAnswers,
    experimentAnswers: collectExperimentAnswers(),
    weighting: DEFAULT_WEIGHTING
  };

  const response = await fetch("/api/personality/assess", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    outputNode.textContent = "猫格评估失败，请检查输入后重试。";
    return;
  }

  const result = await response.json();
  currentProfile = result.cat_profile;
  currentAssessment = result.assessment;

  renderAssessmentSummary(result.assessment);
  renderRadar(currentProfile);
  renderPersonaImageDock(result.assessment?.anime_persona || null);
}

async function interpretAction(event) {
  event.preventDefault();
  abortInterpretationStream();

  if (!currentProfile || !currentAssessment) {
    outputNode.textContent = "请先完成猫格评估，再进行行为解释。";
    return;
  }

  const customAction = customActionInput.value.trim();
  const llm = buildLlmPayload();
  const payload = customAction
    ? { catProfile: currentProfile, actionName: customAction, llm }
    : { catProfile: currentProfile, actionId: actionSelect.value, llm };

  outputNode.textContent = "";
  interpretationStreamController = new AbortController();

  try {
    const response = await fetch("/api/interpreter/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: interpretationStreamController.signal
    });

    if (!response.ok) {
      outputNode.textContent = "行为转译失败，请稍后重试。";
      interpretationStreamController = null;
      return;
    }

    if (!response.body) {
      outputNode.textContent = "行为转译失败，请稍后重试。";
      interpretationStreamController = null;
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }

      outputNode.textContent += decoder.decode(value, { stream: true });
    }

    outputNode.textContent += decoder.decode();
    interpretationStreamController = null;
  } catch (_error) {
    if (_error?.name !== "AbortError") {
      outputNode.textContent = "行为转译失败，请稍后重试。";
    }
    interpretationStreamController = null;
  }
}

async function bootstrap() {
  await Promise.all([loadAssessmentConfig(), loadBehaviors()]);
  restoreLlmFormState();
  bindLlmConfigForm();
  assessmentForm.addEventListener("submit", generateProfile);
  interpretForm.addEventListener("submit", interpretAction);
}

bootstrap().catch((error) => {
  outputNode.textContent = `初始化失败: ${String(error)}`;
});

