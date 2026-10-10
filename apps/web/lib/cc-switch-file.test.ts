import { expect, test } from "vitest";
import initSqlJs from "sql.js/dist/sql-asm.js";
import { parseCcSwitchProvider, readCcSwitchFile } from "./cc-switch-file";

test("Claude and Gemini map their native protocols and deduplicate explicit models", () => {
  const c = parseCcSwitchProvider(
    "id",
    "claude",
    "Name",
    true,
    JSON.stringify({
      env: {
        ANTHROPIC_AUTH_TOKEN: "test-key",
        ANTHROPIC_MODEL: "m",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "m",
      },
    }),
  );
  expect(c).toMatchObject({
    providerKind: "anthropic",
    models: ["m"],
    issue: null,
  });
  expect(
    parseCcSwitchProvider(
      "id",
      "gemini",
      "Name",
      false,
      JSON.stringify({ env: { GOOGLE_API_KEY: "test-key" } }),
    ),
  ).toMatchObject({ providerKind: "gemini", models: [], issue: null });
});
test("Codex Responses imports as Chat; malformed TOML remains an explicit error", () => {
  const config =
    "model='m'\nmodel_provider='p'\n[model_providers.p]\nbase_url='https://example.com/v1'\nwire_api='chat'";
  expect(
    parseCcSwitchProvider(
      "id",
      "codex",
      "Name",
      true,
      JSON.stringify({ config, auth: { OPENAI_API_KEY: "test-key" } }),
    ),
  ).toMatchObject({ models: ["m"], issue: null });
  expect(
    parseCcSwitchProvider(
      "id",
      "codex",
      "Name",
      true,
      JSON.stringify({
        config: config.replace("wire_api='chat'", "wire_api='responses'"),
        auth: { OPENAI_API_KEY: "test-key" },
      }),
    ),
  ).toMatchObject({
    issue: null,
    warning: "responses_as_chat",
    baseUrl: "https://example.com/v1",
    models: ["m"],
  });
  expect(
    parseCcSwitchProvider(
      "id",
      "codex",
      "Name",
      true,
      JSON.stringify({
        config: "model='m'",
        auth: { OPENAI_API_KEY: "test-key" },
      }),
    ),
  ).toMatchObject({ issue: null, warning: "responses_as_chat" });
  expect(
    parseCcSwitchProvider(
      "id",
      "codex",
      "Name",
      true,
      JSON.stringify({ config: "secret invalid TOML" }),
    ).issue,
  ).toBe("invalid_config");
});
test("OAuth and unsafe URLs are rejected without exposing parser diagnostics", () => {
  expect(parseCcSwitchProvider("id", "claude", "Name", true, "{}").issue).toBe(
    "missing_key",
  );
  expect(
    parseCcSwitchProvider(
      "id",
      "claude",
      "Name",
      true,
      JSON.stringify({
        env: {
          ANTHROPIC_AUTH_TOKEN: "test-key",
          ANTHROPIC_BASE_URL: "https://user:secret@example.com",
        },
      }),
    ).issue,
  ).toBe("invalid_endpoint");
});
test("browser parses a selected SQLite database in memory and enforces schema/row limits", async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  try {
    db.run(
      "CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT, is_current INTEGER, settings_config TEXT)",
    );
    db.run("INSERT INTO providers VALUES (?, ?, ?, ?, ?)", [
      "id",
      "claude",
      "Name",
      1,
      '{"env":{"ANTHROPIC_API_KEY":"test-key"}}',
    ]);
    const bytes = db.export();
    expect(await readCcSwitchFile(bytes)).toHaveLength(1);
    expect(db.exec("SELECT COUNT(*) FROM providers")[0]!.values[0]![0]).toBe(1);
    for (let i = 0; i < 200; i++)
      db.run("INSERT INTO providers SELECT * FROM providers LIMIT 1");
    await expect(readCcSwitchFile(db.export())).rejects.toThrow(
      "CC_SWITCH_TOO_MANY_PROVIDERS",
    );
  } finally {
    db.close();
  }
});
