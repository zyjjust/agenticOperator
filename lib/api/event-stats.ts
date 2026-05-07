"use client";
import { useEffect, useState } from "react";
import { fetchJson } from "./client";
import type { EventStats } from "@/app/api/em/event-stats/route";

export function useEventStats(name: string | undefined): EventStats | null {
  const [data, setData] = useState<EventStats | null>(null);
  useEffect(() => {
    if (!name) {
      setData(null);
      return;
    }
    let cancelled = false;
    const tick = () => {
      fetchJson<EventStats>(`/api/em/event-stats?name=${encodeURIComponent(name)}`)
        .then((r) => {
          if (!cancelled) setData(r);
        })
        .catch(() => { /* keep last good */ });
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [name]);
  return data;
}

export type { EventStats };
