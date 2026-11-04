"use client";

import { useEffect, useState } from "react";

import { apiFetch, type HealthResponse } from "@/lib/api";

type State =
  | { kind: "loading" }
  | { kind: "ok"; data: HealthResponse }
  | { kind: "error"; message: string };

export function ApiStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    apiFetch<HealthResponse>("/health")
      .then((data) => setState({ kind: "ok", data }))
      .catch((err: Error) => setState({ kind: "error", message: err.message }));
  }, []);

  if (state.kind === "loading") {
    return <p className="text-zinc-500">Checking API…</p>;
  }
  if (state.kind === "error") {
    return <p className="text-red-600">Health check failed: {state.message}</p>;
  }
  return (
    <p className="text-emerald-600">
      API {state.data.status} ({state.data.environment}), database {state.data.database}
    </p>
  );
}
