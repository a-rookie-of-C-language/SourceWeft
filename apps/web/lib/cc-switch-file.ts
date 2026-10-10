import { parse as parseToml } from "smol-toml";
import type { CcSwitchCandidate } from "./desktop-bridge";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function parseCcSwitchProvider(
  sourceId: string,
  appType: string,
  name: string,
  current: boolean,
  settings: string,
): CcSwitchCandidate {
  const c: CcSwitchCandidate = {
    sourceId,
    appType,
    name,
    current,
    providerKind: "openai-compatible",
    baseUrl: "",
    apiKey: "",
    models: [],
    issue: null,
  };
  try {
    const value = record(JSON.parse(settings));
    const env = record(value.env);
    if (appType === "claude") {
      c.providerKind = "anthropic";
      c.baseUrl = text(env.ANTHROPIC_BASE_URL) || "https://api.anthropic.com";
      c.apiKey = text(env.ANTHROPIC_AUTH_TOKEN) || text(env.ANTHROPIC_API_KEY);
      c.models = [
        ...new Set(
          [
            env.ANTHROPIC_MODEL,
            env.ANTHROPIC_DEFAULT_OPUS_MODEL,
            env.ANTHROPIC_DEFAULT_SONNET_MODEL,
            env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
          ]
            .map(text)
            .filter(Boolean),
        ),
      ];
    } else if (appType === "gemini") {
      c.providerKind = "gemini";
      c.baseUrl =
        text(env.GOOGLE_GEMINI_BASE_URL) ||
        "https://generativelanguage.googleapis.com";
      c.apiKey = text(env.GEMINI_API_KEY) || text(env.GOOGLE_API_KEY);
      c.models = [text(env.GEMINI_MODEL)].filter(Boolean);
    } else if (appType === "codex") {
      const config = parseToml(text(value.config));
      const provider = text(config.model_provider) || "openai";
      const definition = record(record(config.model_providers)[provider]);
      c.baseUrl =
        text(definition.base_url) ||
        (provider === "openai" ? "https://api.openai.com/v1" : "");
      c.apiKey = text(record(value.auth).OPENAI_API_KEY);
      c.models = [text(config.model)].filter(Boolean);
      const wire = text(definition.wire_api) || "responses";
      if (wire === "responses") c.warning = "responses_as_chat";
      else if (wire !== "chat") c.issue = "unsupported_protocol";
    } else c.issue = "unsupported_app";
    if (!c.issue && !c.apiKey) c.issue = "missing_key";
    if (!c.issue) {
      try {
        const u = new URL(c.baseUrl);
        if (
          !["https:", "http:"].includes(u.protocol) ||
          u.username ||
          u.password ||
          u.search ||
          u.hash
        )
          c.issue = "invalid_endpoint";
      } catch {
        c.issue = "invalid_endpoint";
      }
    }
  } catch {
    c.issue = "invalid_config";
  }
  return c;
}

// The asm.js build is bundled lazily: no CDN or external WASM fetch, and no
// database upload. A browser-selected standalone DB must have its WAL checkpointed.
export async function readCcSwitchFile(
  bytes: Uint8Array,
): Promise<CcSwitchCandidate[]> {
  if (bytes.byteLength > 64 * 1024 * 1024)
    throw new Error("CC_SWITCH_FILE_TOO_LARGE");
  const { default: initSqlJs } = await import("sql.js/dist/sql-asm.js");
  const SQL = await initSqlJs();
  const database = new SQL.Database(bytes);
  try {
    const result = database.exec(
      "SELECT id, app_type, name, is_current, settings_config FROM providers LIMIT 201",
    );
    const rows = result[0]?.values ?? [];
    if (rows.length > 200) throw new Error("CC_SWITCH_TOO_MANY_PROVIDERS");
    return rows.map((row) => {
      const [id, app, name, current, config] = row;
      if (
        typeof id !== "string" ||
        typeof app !== "string" ||
        typeof name !== "string" ||
        typeof config !== "string" ||
        config.length > 1024 * 1024
      )
        throw new Error("CC_SWITCH_UNSUPPORTED_SCHEMA");
      return parseCcSwitchProvider(id, app, name, current === 1, config);
    });
  } finally {
    database.close();
  }
}
