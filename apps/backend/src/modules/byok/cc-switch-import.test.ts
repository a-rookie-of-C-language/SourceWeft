import { beforeEach, expect, test, vi } from "vitest";
import { importCcSwitchRequestSchema } from "@sourceweft/contracts";

const state = vi.hoisted(() => ({
  credentials: [] as Array<Record<string, any>>,
  models: [] as Array<Record<string, any>>,
  failModel: false,
  authorize: vi.fn(),
  validate: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  locks: 0,
}));
vi.mock("../workspace/guards", () => ({
  requireContentWorkspace: state.authorize,
}));
vi.mock("./service", () => ({
  resolveImportedModelCapabilities: vi.fn(async () => ({
    supportsThinking: false,
    supportsImageInput: false,
    supportedParameters: [],
    supportedEfforts: [],
    reasoning: false,
    reasoningEffort: false,
    includeReasoning: false,
    supportSources: ["model-catalog"],
  })),
}));
vi.mock("../../shared/model-gateway/network", () => ({
  validateLlmEndpoint: state.validate,
}));
vi.mock("../../shared/team-secrets", () => ({
  encryptTeamSecret: state.encrypt,
  decryptTeamSecret: state.decrypt,
}));
vi.mock("@sourceweft/db", () => {
  const credentials = {
    id: "credential.id",
    teamId: "credential.team",
    workspaceId: "credential.workspace",
    userId: "credential.user",
  };
  const models = {
    id: "model.id",
    credentialId: "model.credential",
    workspaceId: "model.workspace",
    userId: "model.user",
  };
  const data = (table: unknown) =>
    table === credentials ? state.credentials : state.models;
  const tx = {
    execute: async () => {
      state.locks++;
    },
    select: () => ({
      from: (table: unknown) => ({ where: async () => data(table) }),
    }),
    insert: (table: unknown) => ({
      values: async (row: Record<string, any>) => {
        if (table === models && state.failModel)
          throw new Error("model insert failed");
        data(table).push({ isActive: true, ...row });
      },
    }),
    update: (table: unknown) => ({
      set: (changes: object) => ({
        where: async () => {
          Object.assign(data(table)[0]!, changes);
        },
      }),
    }),
  };
  return {
    modelGatewayByokCredentials: credentials,
    modelGatewayByokModels: models,
    db: {
      transaction: async (fn: (value: typeof tx) => Promise<unknown>) => {
        const oldCredentials = structuredClone(state.credentials),
          oldModels = structuredClone(state.models);
        try {
          return await fn(tx);
        } catch (error) {
          state.credentials = oldCredentials;
          state.models = oldModels;
          throw error;
        }
      },
    },
  };
});
import { importCcSwitch } from "./cc-switch-import";

const input = {
  workspaceId: "workspace",
  userId: "user",
  sourceId: "source",
  appType: "claude" as const,
  name: "CC provider",
  providerKind: "anthropic" as const,
  baseUrl: "https://example.com",
  apiKey: "test-key",
  models: ["model-a", "model-a"],
};
beforeEach(() => {
  vi.clearAllMocks();
  state.credentials = [];
  state.models = [];
  state.failModel = false;
  state.locks = 0;
  state.authorize.mockResolvedValue({
    id: "workspace",
    organizationId: "team",
  });
  state.validate.mockImplementation(async (url) => url);
  state.encrypt.mockImplementation(async (key) => `encrypted:${key}`);
  state.decrypt.mockImplementation(async (key) =>
    key.slice("encrypted:".length),
  );
});
test("import encrypts into BYOK, deduplicates models and skips an unchanged retry", async () => {
  expect(await importCcSwitch(input)).toMatchObject({
    status: "imported",
    modelCount: 1,
  });
  expect(state.credentials[0]).toMatchObject({
    providerName: "custom",
    workspaceId: "workspace",
    userId: "user",
    apiKeyEncrypted: "encrypted:test-key",
    metadataJson: { importSource: "cc-switch" },
  });
  expect(state.credentials[0]).not.toHaveProperty("apiKey");
  expect(await importCcSwitch(input)).toMatchObject({
    status: "skipped",
    modelCount: 0,
  });
  expect(state.credentials).toHaveLength(1);
  expect(state.models).toHaveLength(1);
  expect(state.models[0]!.capabilitiesJson.supportSources).toEqual([
    "model-catalog",
  ]);
  expect(state.locks).toBe(2);
});
test("changed secrets/endpoints require explicit replacement", async () => {
  await importCcSwitch(input);
  expect(await importCcSwitch({ ...input, apiKey: "new-key" })).toMatchObject({
    status: "changed",
  });
  expect(state.credentials[0]!.apiKeyEncrypted).toBe("encrypted:test-key");
  expect(
    await importCcSwitch({ ...input, apiKey: "new-key", updateExisting: true }),
  ).toMatchObject({ status: "updated" });
  expect(state.credentials[0]!.apiKeyEncrypted).toBe("encrypted:new-key");
});
test("a model insert failure rolls back its credential and all models", async () => {
  state.failModel = true;
  await expect(importCcSwitch(input)).rejects.toThrow("model insert failed");
  expect(state.credentials).toHaveLength(0);
  expect(state.models).toHaveLength(0);
});
test("workspace authorization and endpoint policy failures never persist credentials", async () => {
  state.authorize.mockRejectedValueOnce(new Error("forbidden"));
  await expect(importCcSwitch(input)).rejects.toThrow("forbidden");
  expect(state.encrypt).not.toHaveBeenCalled();
  state.validate.mockRejectedValueOnce(new Error("private endpoint denied"));
  await expect(importCcSwitch(input)).rejects.toThrow(
    "private endpoint denied",
  );
  expect(state.credentials).toHaveLength(0);
});
test("request schema rejects missing models and excessive/unsupported input without coercing protocols", () => {
  const { workspaceId, userId, ...payload } = input;
  expect(importCcSwitchRequestSchema.safeParse(payload).success).toBe(true);
  for (const changes of [
    { models: [] },
    { models: Array(31).fill("m") },
    { appType: "oauth" },
    { providerKind: "responses" },
    { apiKey: "" },
  ]) {
    expect(
      importCcSwitchRequestSchema.safeParse({ ...payload, ...changes }).success,
    ).toBe(false);
  }
});
