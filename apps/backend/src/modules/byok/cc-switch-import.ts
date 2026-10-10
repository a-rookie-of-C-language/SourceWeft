import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  modelGatewayByokCredentials as credentials,
  modelGatewayByokModels as models,
} from "@sourceweft/db";
import type {
  ImportCcSwitchRequest,
  ImportCcSwitchResponse,
} from "@sourceweft/contracts";
import {
  decryptTeamSecret,
  encryptTeamSecret,
} from "../../shared/team-secrets";
import { requireContentWorkspace } from "../workspace/guards";
import { validateLlmEndpoint } from "../../shared/model-gateway/network";
import { resolveImportedModelCapabilities } from "./service";

// Each provider and its models commit atomically. Stable source identity and a
// transaction lock make retries/concurrent imports safe without replacing other credentials.
export async function importCcSwitch(
  input: ImportCcSwitchRequest & { workspaceId: string; userId: string },
): Promise<ImportCcSwitchResponse> {
  const workspace = await requireContentWorkspace(input);
  const baseUrl = await validateLlmEndpoint(input.baseUrl);
  const requestedModels = [...new Set(input.models)];
  const capabilitySnapshots = new Map(
    await Promise.all(
      requestedModels.map(
        async (name) =>
          [name, await resolveImportedModelCapabilities(name)] as const,
      ),
    ),
  );
  const encrypted = await encryptTeamSecret(
    input.apiKey,
    workspace.organizationId,
  );
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`cc-switch:${workspace.id}:${input.userId}`}, 0))`,
    );
    const owned = await tx
      .select()
      .from(credentials)
      .where(
        and(
          eq(credentials.teamId, workspace.organizationId),
          eq(credentials.workspaceId, workspace.id),
          eq(credentials.userId, input.userId),
        ),
      );
    const existing = owned.find(
      (row) =>
        row.metadataJson?.importSource === "cc-switch" &&
        row.metadataJson?.sourceId === input.sourceId &&
        row.metadataJson?.appType === input.appType,
    );
    const id = existing?.id ?? randomUUID();
    if (existing) {
      const key = await decryptTeamSecret(
        existing.apiKeyEncrypted,
        workspace.organizationId,
      );
      const changed =
        existing.baseUrl !== baseUrl ||
        existing.providerKind !== input.providerKind ||
        key !== input.apiKey ||
        !existing.isActive;
      if (changed && !input.updateExisting)
        return { status: "changed", credentialId: id, modelCount: 0 };
      if (changed)
        await tx
          .update(credentials)
          .set({
            baseUrl,
            providerKind: input.providerKind,
            apiKeyEncrypted: encrypted,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(credentials.id, id));
    } else {
      await tx.insert(credentials).values({
        id,
        teamId: workspace.organizationId,
        workspaceId: workspace.id,
        userId: input.userId,
        providerName: "custom",
        providerKind: input.providerKind,
        baseUrl,
        credentialAlias: `CC Switch: ${input.name} (${input.appType}) [${id.slice(0, 8)}]`,
        apiKeyEncrypted: encrypted,
        metadataJson: {
          importSource: "cc-switch",
          sourceId: input.sourceId,
          appType: input.appType,
        },
      });
    }
    const saved = await tx
      .select()
      .from(models)
      .where(
        and(
          eq(models.credentialId, id),
          eq(models.workspaceId, workspace.id),
          eq(models.userId, input.userId),
        ),
      );
    let modelCount = 0;
    for (const modelName of requestedModels) {
      const previous = saved.find(
        (m) => m.modelName === modelName && m.modelType === "llm",
      );
      if (previous?.isActive) continue;
      if (previous)
        await tx
          .update(models)
          .set({ isActive: true, updatedAt: new Date() })
          .where(eq(models.id, previous.id));
      else
        await tx.insert(models).values({
          id: randomUUID(),
          credentialId: id,
          teamId: workspace.organizationId,
          workspaceId: workspace.id,
          userId: input.userId,
          providerName: "custom",
          modelName,
          displayName: modelName,
          modelType: "llm",
          capabilitiesJson: capabilitySnapshots.get(modelName) ?? null,
        });
      modelCount++;
    }
    return {
      status: existing
        ? input.updateExisting
          ? "updated"
          : modelCount
            ? "imported"
            : "skipped"
        : "imported",
      credentialId: id,
      modelCount,
    };
  });
}
