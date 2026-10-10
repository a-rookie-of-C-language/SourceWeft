"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@sourceweft/ui-web/components/ui/button";
import { Input } from "@sourceweft/ui-web/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@sourceweft/ui-web/components/ui/dialog";
import {
  desktopBridge,
  readCcSwitchConfig,
  type CcSwitchCandidate,
} from "../../../../lib/desktop-bridge";
import { contentClient, apiBaseUrl } from "../../../../lib/sdk";
import { readCcSwitchFile } from "../../../../lib/cc-switch-file";

type Row = CcSwitchCandidate & {
  selected: boolean;
  modelInput: string;
  result?: string;
  updateExisting?: boolean;
};

export function CcSwitchImportDialog({
  open,
  onOpenChange,
  workspaceId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string | null;
  onImported: () => Promise<void>;
}) {
  const t = useTranslations("dashboardChatCanvas.ccSwitchImport");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [consent, setConsent] = useState(false);
  const desktop = desktopBridge.isAvailable();
  function readError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === "CC_SWITCH_NOT_FOUND") return t("notFound");
    if (message === "CC_SWITCH_SELECTION_CANCELLED") return t("cancelled");
    const code = /^CC_SWITCH_[A-Z_]+$/.test(message)
      ? message
      : message.includes("DESKTOP_ACCESS_DENIED")
        ? "DESKTOP_ACCESS_DENIED"
        : /not allowed|denied|permission/i.test(message)
          ? "DESKTOP_IPC_PERMISSION_DENIED"
          : /not found|unknown command/i.test(message)
            ? "DESKTOP_COMMAND_UNAVAILABLE"
            : /invalid args|missing required key/i.test(message)
              ? "DESKTOP_INVALID_ARGUMENTS"
              : "DESKTOP_IPC_FAILED";
    return `${t("readFailed")} (${code})`;
  }

  useEffect(() => {
    if (!open) {
      setRows([]);
      setError("");
      setConsent(false);
    }
  }, [open]);
  useEffect(() => {
    if (!open || !desktop) return;
    let cancelled = false;
    setBusy(true);
    setError("");
    readCcSwitchConfig()
      .then((candidates) => {
        if (cancelled) return;
        setRows(
          candidates.map((c) => ({
            ...c,
            selected: c.current && !c.issue,
            modelInput: c.models.join(", "),
          })),
        );
        if (!candidates.length) setError(t("empty"));
      })
      .catch((error) => {
        if (!cancelled) setError(readError(error));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, desktop, t]);
  async function load(chooseFile: boolean) {
    setBusy(true);
    setError("");
    setRows([]);
    setConsent(false);
    try {
      const candidates = await readCcSwitchConfig(chooseFile);
      setRows(
        candidates.map((c) => ({
          ...c,
          selected: c.current && !c.issue,
          modelInput: c.models.join(", "),
        })),
      );
      if (!candidates.length) setError(t("empty"));
    } catch (e) {
      setError(readError(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(index: number, changes: Partial<Row>) {
    setRows((previous) =>
      previous.map((r, i) => (i === index ? { ...r, ...changes } : r)),
    );
  }

  async function loadFile(file: File) {
    setBusy(true);
    setError("");
    setRows([]);
    setConsent(false);
    try {
      if (file.size > 64 * 1024 * 1024)
        throw new Error("CC_SWITCH_FILE_TOO_LARGE");
      const candidates = await readCcSwitchFile(
        new Uint8Array(await file.arrayBuffer()),
      );
      setRows(
        candidates.map((c) => ({
          ...c,
          selected: c.current && !c.issue,
          modelInput: c.models.join(", "),
        })),
      );
      if (!candidates.length) setError(t("empty"));
    } catch {
      setError(t("readFailed"));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!workspaceId || !consent) return;
    setBusy(true);
    setError("");
    for (let index = 0; index < rows.length; index++) {
      const row = rows[index];
      if (
        !row ||
        !row.selected ||
        row.issue ||
        (row.result && row.result !== "failed" && row.result !== "changed")
      )
        continue;
      try {
        const result = await contentClient.importCcSwitch(workspaceId, {
          sourceId: row.sourceId,
          appType: row.appType as "claude" | "codex" | "gemini",
          name: row.name,
          providerKind: row.providerKind,
          baseUrl: row.baseUrl,
          apiKey: row.apiKey,
          models: row.modelInput
            .split(/[,\n]/)
            .map((m) => m.trim())
            .filter(Boolean),
          updateExisting: row.updateExisting ?? false,
        });
        edit(index, {
          result: result.status,
          ...(result.status !== "changed"
            ? { apiKey: "", selected: false }
            : {}),
        });
      } catch {
        // Never display backend/parser errors that could contain submitted secrets.
        edit(index, { result: "failed" });
      }
    }
    try {
      await onImported();
    } catch {
      setError(t("refreshFailed"));
    }
    setBusy(false);
  }
  const selected = rows.filter((r) => r.selected && !r.issue);
  const valid =
    selected.length > 0 &&
    selected.every((r) => {
      const models = r.modelInput
        .split(/[,\n]/)
        .map((m) => m.trim())
        .filter(Boolean);
      return (
        models.length > 0 &&
        models.length <= 30 &&
        models.every((m) => m.length <= 256) &&
        (r.result !== "changed" || r.updateExisting)
      );
    });
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) onOpenChange(value);
      }}
    >
      <DialogContent
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
        constrainWidth={false}
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {desktop ? (
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy} onClick={() => void load(false)}>
              <Download className="size-4" />
              {t("detect")}
            </Button>
            <Button
              disabled={busy}
              variant="outline"
              onClick={() => void load(true)}
            >
              {t("chooseFile")}
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              {t("browserFileHelp")}
            </p>
            <label htmlFor="cc-switch-file" className="text-sm">
              {t("chooseFile")}
            </label>
            <Input
              id="cc-switch-file"
              type="file"
              accept=".db,.sqlite,.sqlite3"
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void loadFile(file);
                e.target.value = "";
              }}
            />
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="space-y-3">
          {rows.map((row, index) => (
            <div
              key={`${row.appType}:${row.sourceId}`}
              className="rounded-lg border p-3 space-y-2"
            >
              <label className="flex items-center gap-2 font-medium">
                <input
                  type="checkbox"
                  disabled={busy || !!row.issue || !row.apiKey}
                  checked={row.selected}
                  onChange={(e) => edit(index, { selected: e.target.checked })}
                />
                {row.name}{" "}
                <span className="text-xs text-muted-foreground">
                  {row.appType}
                  {row.current ? ` · ${t("current")}` : ""}
                </span>
              </label>
              <p className="break-all text-xs text-muted-foreground">
                {row.baseUrl} · {row.providerKind}
              </p>
              {row.issue ? (
                <p className="text-sm text-destructive">
                  {t(`issues.${row.issue}`)}
                </p>
              ) : (
                <>
                  {row.warning && (
                    <p className="text-xs text-muted-foreground">
                      {t(`warnings.${row.warning}`)}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("keyHidden")}
                  </p>
                  <label
                    className="block text-sm"
                    htmlFor={`cc-model-${index}`}
                  >
                    {t("models")}
                  </label>
                  <Input
                    id={`cc-model-${index}`}
                    disabled={busy || !row.apiKey}
                    value={row.modelInput}
                    onChange={(e) =>
                      edit(index, { modelInput: e.target.value })
                    }
                  />
                  {!row.modelInput.trim() && (
                    <p className="text-xs text-muted-foreground">
                      {t("modelRequired")}
                    </p>
                  )}
                </>
              )}
              {row.result && (
                <p role="status" className="text-sm">
                  {t(`results.${row.result}`)}
                </p>
              )}
              {row.result === "changed" && (
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={row.updateExisting ?? false}
                    onChange={(e) =>
                      edit(index, { updateExisting: e.target.checked })
                    }
                  />
                  {t("updateExisting")}
                </label>
              )}
            </div>
          ))}
        </div>
        {rows.length > 0 && (
          <label className="flex items-start gap-2 text-sm">
            <input
              className="mt-1"
              type="checkbox"
              checked={consent}
              disabled={busy}
              onChange={(e) => setConsent(e.target.checked)}
            />
            <span>
              {t("consent", {
                server: apiBaseUrl,
                workspace: workspaceId ?? "",
              })}
            </span>
          </label>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("close")}
          </Button>
          <Button
            disabled={busy || !valid || !consent || !workspaceId}
            onClick={() => void save()}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t("import")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
