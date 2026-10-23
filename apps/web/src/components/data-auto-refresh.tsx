"use client";

import type { WhatsappDataSourceDto } from "@wpptrack/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useTransition } from "react";
import { displayTimeZone } from "../lib/date-time";

const refreshIntervalMs = 60_000;

function sourceName(source: WhatsappDataSourceDto | null) {
  if (source?.mode === "external") {
    return "Integração externa MySQL";
  }

  return source?.mode === "native"
    ? "WhatsApp em tempo real"
    : "Dados do workspace";
}

function sourceFreshness(source: WhatsappDataSourceDto | null) {
  if (source?.lastSyncStatus === "failed") {
    return "Falha na última sincronização";
  }

  if (!source?.lastSyncCompletedAt) {
    return "Atualização automática ativa";
  }

  return `Sincronizado em ${new Date(source.lastSyncCompletedAt).toLocaleString(
    "pt-BR",
    {
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      month: "2-digit",
      timeZone: displayTimeZone,
    },
  )}`;
}

export function DataAutoRefresh({
  source,
}: {
  source: WhatsappDataSourceDto | null;
}) {
  const router = useRouter();
  const [isRefreshing, startRefreshTransition] = useTransition();
  const refresh = useCallback(() => {
    startRefreshTransition(() => {
      router.refresh();
    });
  }, [router]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    }, refreshIntervalMs);

    return () => {
      window.clearInterval(interval);
    };
  }, [refresh]);

  return (
    <div className="data-refresh-bar" aria-live="polite">
      <div>
        <span>Dados</span>
        <strong>{sourceName(source)}</strong>
        <small>
          {isRefreshing ? "Atualizando..." : sourceFreshness(source)}
        </small>
      </div>
      <button
        className="button ghost"
        disabled={isRefreshing}
        onClick={refresh}
        type="button"
      >
        {isRefreshing ? "Atualizando" : "Atualizar"}
      </button>
    </div>
  );
}
