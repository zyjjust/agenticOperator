"use client";
import * as React from 'react';

export type SseState = 'connecting' | 'open' | 'reconnecting' | 'error';

export type UseSseOptions = {
  enabled?: boolean;
  reconnectDelayMs?: number;
};

/**
 * Subscribes to a server-sent events endpoint with auto-reconnect.
 *
 * - Reconnects after `reconnectDelayMs` on transport error.
 * - Listens to default `message` plus the named events used by /api/stream:
 *   `activity`, `heartbeat`, `error`.
 * - Clean up on unmount.
 */
export function useSSE<T = unknown>(
  url: string,
  onEvent: (data: T, eventName: string) => void,
  opts: UseSseOptions = {},
): { state: SseState; close: () => void } {
  const enabled = opts.enabled ?? true;
  const delay = opts.reconnectDelayMs ?? 3000;
  const [state, setState] = React.useState<SseState>('connecting');
  const ref = React.useRef<EventSource | null>(null);
  const cbRef = React.useRef(onEvent);
  cbRef.current = onEvent;

  React.useEffect(() => {
    if (!enabled || !url) return;
    let cancelled = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      setState('connecting');
      const es = new EventSource(url);
      ref.current = es;

      es.onopen = () => {
        if (!cancelled) setState('open');
      };

      es.onerror = () => {
        if (cancelled) return;
        setState('reconnecting');
        es.close();
        reconnectTimer = setTimeout(connect, delay);
      };

      es.onmessage = (ev) => {
        try {
          cbRef.current(JSON.parse(ev.data) as T, ev.type || 'message');
        } catch {
          // ignore malformed payloads
        }
      };

      for (const name of ['activity', 'heartbeat', 'error']) {
        es.addEventListener(name, (ev: MessageEvent) => {
          try {
            cbRef.current(JSON.parse(ev.data) as T, name);
          } catch {
            // ignore
          }
        });
      }
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ref.current?.close();
    };
  }, [url, enabled, delay]);

  const close = React.useCallback(() => ref.current?.close(), []);
  return { state, close };
}
