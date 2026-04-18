import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mapAvatarByPersonality } from "./src/avatar-mapping.js";
import { BEHAVIOR_LIBRARY, findBehavior } from "./src/behavior-library.js";
import {
  generateInterpretation,
  getLlmRuntimeSummary,
  streamInterpretation,
  validateLlmRequestConfig
} from "./src/interpreter.js";
import { buildPersonaImageLibrary } from "./src/persona-image-library.js";
import {
  calculatePersonalityScores,
  evaluatePersonalityAssessment,
  EXPERIMENT_ITEMS,
  inferArchetype,
  QUESTIONNAIRE_ITEMS
} from "./src/personality-engine.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PUBLIC_DIR = join(__dirname, "public");
const PORT = Number(process.env.PORT) || 3100;

const MIME_MAP = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readJsonBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      if (!body.trim()) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch (_error) {
        reject(new Error("Invalid JSON body"));
      }
    });

    req.on("error", (error) => reject(error));
  });
}

function sanitizePublicPath(urlPath) {
  const incoming = typeof urlPath === "string" ? urlPath : "/";
  const withDefault = incoming === "/" ? "/index.html" : incoming;
  const normalized = normalize(withDefault).replace(/^([/\\])+/, "");
  const resolved = resolve(PUBLIC_DIR, normalized);
  const rel = relative(PUBLIC_DIR, resolved);
  const isInsidePublic = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));

  return {
    filePath: resolved,
    isInsidePublic
  };
}

async function serveStaticFile(res, urlPath) {
  const { filePath, isInsidePublic } = sanitizePublicPath(urlPath);

  if (!isInsidePublic) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    sendText(res, 404, "Not Found");
    return;
  }

  const stats = await stat(filePath);
  if (!stats.isFile()) {
    sendText(res, 404, "Not Found");
    return;
  }

  const extension = extname(filePath).toLowerCase();
  const mime = MIME_MAP[extension] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  createReadStream(filePath).pipe(res);
}

function buildCatProfile({ catName, scores, baseTemperament }) {
  const archetype = inferArchetype(scores);
  const avatar = mapAvatarByPersonality(scores, archetype);
  return {
    cat_profile: {
      name: catName || "Unnamed",
      scores,
      archetype,
      base_temperament: baseTemperament || null
    },
    avatar
  };
}

const server = createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = parsedUrl.pathname;
    const method = req.method || "GET";

    if (method === "GET" && pathname === "/api/health") {
      sendJson(res, 200, { ok: true, now: new Date().toISOString() });
      return;
    }

    if (method === "GET" && pathname === "/api/behaviors") {
      sendJson(res, 200, { items: BEHAVIOR_LIBRARY });
      return;
    }

    if (method === "GET" && pathname === "/api/personality/questionnaire") {
      sendJson(res, 200, { items: QUESTIONNAIRE_ITEMS });
      return;
    }

    if (method === "GET" && pathname === "/api/personality/experiments") {
      sendJson(res, 200, { items: EXPERIMENT_ITEMS });
      return;
    }

    if (method === "GET" && pathname === "/api/personality/persona-images") {
      sendJson(res, 200, {
        items: buildPersonaImageLibrary(),
        asset_dir: "/assets/personas"
      });
      return;
    }

    if (method === "POST" && pathname === "/api/personality/assess") {
      const body = await readJsonBody(req);
      const assessment = evaluatePersonalityAssessment(body);
      const result = buildCatProfile({
        catName: body.catName,
        scores: assessment.stage_scores.final,
        baseTemperament: assessment.base_temperament
      });

      sendJson(res, 200, {
        ...result,
        assessment
      });
      return;
    }

    if (method === "POST" && pathname === "/api/personality/score") {
      const body = await readJsonBody(req);
      const questionMaxScore = Number(body.questionMaxScore) || 5;
      const scores = calculatePersonalityScores(body.traitObservations, questionMaxScore);

      const result = buildCatProfile({
        catName: body.catName,
        scores
      });

      sendJson(res, 200, result);
      return;
    }

    if (method === "POST" && pathname === "/api/interpreter") {
      const body = await readJsonBody(req);
      const catProfile = body.catProfile;
      if (!catProfile?.scores) {
        sendJson(res, 400, { error: "catProfile.scores is required." });
        return;
      }
      const llmConfigError = validateLlmRequestConfig(body.llm);
      if (llmConfigError) {
        sendJson(res, 400, { error: llmConfigError });
        return;
      }

      const behavior =
        findBehavior({ actionId: body.actionId, actionName: body.actionName }) || {
          action_id: "custom_action",
          action_name: body.actionName || "unknown_action",
          base_meaning: body.baseMeaning || "No predefined meaning. Infer from context."
        };

      const interpretation = await generateInterpretation({
        catProfile,
        actionName: behavior.action_name,
        baseMeaning: behavior.base_meaning,
        llmConfig: body.llm
      });

      sendJson(res, 200, {
        action: behavior,
        interpretation: interpretation.line,
        prompt_preview: interpretation.prompt
      });
      return;
    }

    if (method === "POST" && pathname === "/api/interpreter/stream") {
      const body = await readJsonBody(req);
      const catProfile = body.catProfile;
      if (!catProfile?.scores) {
        sendJson(res, 400, { error: "catProfile.scores is required." });
        return;
      }
      const llmConfigError = validateLlmRequestConfig(body.llm);
      if (llmConfigError) {
        sendJson(res, 400, { error: llmConfigError });
        return;
      }

      const behavior =
        findBehavior({ actionId: body.actionId, actionName: body.actionName }) || {
          action_id: "custom_action",
          action_name: body.actionName || "unknown_action",
          base_meaning: body.baseMeaning || "No predefined meaning. Infer from context."
        };

      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });

      await streamInterpretation({
        catProfile,
        actionName: behavior.action_name,
        baseMeaning: behavior.base_meaning,
        llmConfig: body.llm,
        onDelta: (chunk) => {
          if (!res.writableEnded) {
            res.write(chunk);
          }
        }
      });

      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    if (method === "POST" && pathname === "/api/workflow/demo") {
      const body = await readJsonBody(req);
      const llmConfigError = validateLlmRequestConfig(body.llm);
      if (llmConfigError) {
        sendJson(res, 400, { error: llmConfigError });
        return;
      }
      const scores = calculatePersonalityScores(
        body.traitObservations,
        Number(body.questionMaxScore) || 5
      );
      const profileResult = buildCatProfile({
        catName: body.catName,
        scores
      });

      const behavior =
        findBehavior({ actionId: body.actionId, actionName: body.actionName }) ||
        BEHAVIOR_LIBRARY[0];
      const interpretation = await generateInterpretation({
        catProfile: profileResult.cat_profile,
        actionName: behavior.action_name,
        baseMeaning: behavior.base_meaning,
        llmConfig: body.llm
      });

      sendJson(res, 200, {
        ...profileResult,
        action: behavior,
        interpretation: interpretation.line
      });
      return;
    }

    if (method === "GET") {
      await serveStaticFile(res, pathname);
      return;
    }

    sendJson(res, 404, { error: "Route not found." });
  } catch (error) {
    sendJson(res, 500, {
      error: "Internal server error.",
      detail: error instanceof Error ? error.message : "Unknown error"
    });
  }
});

server.listen(PORT, () => {
  const llm = getLlmRuntimeSummary();
  const llmEnabled = llm.enabled;
  console.log(`[Cyber Cat-Spirit] server listening on http://localhost:${PORT}`);
  if (llmEnabled) {
    console.log(
      `[Cyber Cat-Spirit] LLM integration: enabled (${llm.provider}, ${llm.model}, ${llm.apiInterface})`
    );
  } else {
    console.log("[Cyber Cat-Spirit] LLM integration: fallback mode");
  }
});
