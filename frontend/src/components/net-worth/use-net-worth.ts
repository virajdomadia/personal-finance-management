"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { logout } from "@/app/login/actions";
import { ApiError, apiFetch } from "@/lib/api";
import type { NetWorthHistory, NetWorthRange } from "@/lib/net-worth";

export type HistoryLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; data: NetWorthHistory };

// The history for a range. A new range keeps the last data on screen until the new one arrives.
// The request also writes today's snapshot on the server the first time each day.
export function useNetWorth(range: NetWorthRange): { load: HistoryLoad; retry: () => void } {
  const [load, setLoad] = useState<HistoryLoad>({ status: "loading" });
  const latest = useRef(0);

  const fetchHistory = useCallback(() => {
    const request = ++latest.current;
    apiFetch<NetWorthHistory>(`/net-worth?range=${range}`)
      .then((data) => {
        if (request === latest.current) setLoad({ status: "ready", data });
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 401) void logout();
        else if (request === latest.current) setLoad({ status: "error" });
      });
  }, [range]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const retry = useCallback(() => {
    setLoad({ status: "loading" });
    fetchHistory();
  }, [fetchHistory]);

  return { load, retry };
}
