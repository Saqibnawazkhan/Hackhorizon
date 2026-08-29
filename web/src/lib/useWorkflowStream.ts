"use client";

/**
 * Live execution feed for screens 4a / 4b.
 *
 * Connects to `ws://host/ws/workflows/{id}?access_token=…&last_seq=N`. The
 * backend replays every event after `last_seq` before live frames begin, so
 * this hook keeps the highest sequence number it has rendered and reconnects
 * with it — a dropped socket resumes exactly where it stopped rather than
 * restarting the stepper or double-counting a step.
 *
 * Every event has a REST equivalent (`GET /workflows/{id}`), so when the
 * socket cannot be held open the caller falls back to polling and the screen
 * still renders. That fallback is what `connection` reports.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { wsUrl } from "./api";
import { useAuth } from "./auth";
import type { WSFrame } from "./types";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "open"
  | "reconnecting"
  | "closed"
  | "error";

interface Options {
  /** Pause the socket once the workflow can no longer emit anything. */
  enabled?: boolean;
  /** Called for every non-heartbeat frame, newest last. */
  onEvent?: (frame: WSFrame) => void;
}

export interface StreamResult {
  frames: WSFrame[];
  lastSeq: number;
  connection: ConnectionState;
  /** Server heartbeat timestamp — proves the socket is alive when idle. */
  lastHeartbeat: string | null;
  reconnect: () => void;
}

const MAX_BUFFERED_FRAMES = 400;

export function useWorkflowStream(
  workflowId: string | null,
  { enabled = true, onEvent }: Options = {},
): StreamResult {
  const { accessToken } = useAuth();
  const [frames, setFrames] = useState<WSFrame[]>([]);
  const [connection, setConnection] = useState<ConnectionState>("idle");
  const [lastHeartbeat, setLastHeartbeat] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const lastSeqRef = useRef(0);
  const attemptRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  const reconnect = useCallback(() => {
    attemptRef.current = 0;
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!workflowId || !enabled) {
      setConnection("idle");
      return;
    }

    let cancelled = false;

    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };

    const open = async () => {
      const token = await accessToken();
      if (cancelled) return;
      if (!token) {
        setConnection("error");
        return;
      }

      setConnection(attemptRef.current === 0 ? "connecting" : "reconnecting");

      const socket = new WebSocket(
        wsUrl(workflowId, token, lastSeqRef.current),
      );
      socketRef.current = socket;

      socket.onopen = () => {
        if (cancelled) return;
        attemptRef.current = 0;
        setConnection("open");
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        let frame: WSFrame;
        try {
          frame = JSON.parse(event.data as string) as WSFrame;
        } catch {
          return;
        }

        if (frame.type === "heartbeat") {
          setLastHeartbeat(
            (frame.payload as { server_time?: string } | undefined)
              ?.server_time ?? new Date().toISOString(),
          );
          return;
        }

        // Replay and live frames can overlap by one at reconnect time; the
        // sequence number is the only safe dedupe key.
        if (typeof frame.seq === "number") {
          if (frame.seq <= lastSeqRef.current) return;
          lastSeqRef.current = frame.seq;
        }

        setFrames((prev) => {
          const next = [...prev, frame];
          return next.length > MAX_BUFFERED_FRAMES
            ? next.slice(next.length - MAX_BUFFERED_FRAMES)
            : next;
        });
        onEventRef.current?.(frame);
      };

      socket.onerror = () => {
        if (!cancelled) setConnection("error");
      };

      socket.onclose = (event) => {
        if (cancelled) return;
        socketRef.current = null;

        // 1008 is the server refusing us (bad token, not visible, vendor).
        // Retrying that just loops, so stop and let the page fall back.
        if (event.code === 1008) {
          setConnection("closed");
          return;
        }

        attemptRef.current += 1;
        if (attemptRef.current > 6) {
          setConnection("closed");
          return;
        }
        setConnection("reconnecting");
        const delay = Math.min(1000 * 2 ** (attemptRef.current - 1), 15_000);
        timerRef.current = setTimeout(() => void open(), delay);
      };
    };

    void open();

    return () => {
      cancelled = true;
      clearTimer();
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket && socket.readyState <= WebSocket.OPEN) {
        socket.close(1000, "unmounted");
      }
    };
  }, [workflowId, enabled, accessToken, nonce]);

  // A different workflow means a different sequence space.
  useEffect(() => {
    lastSeqRef.current = 0;
    setFrames([]);
    setLastHeartbeat(null);
  }, [workflowId]);

  return {
    frames,
    lastSeq: lastSeqRef.current,
    connection,
    lastHeartbeat,
    reconnect,
  };
}

/** Statuses after which no further frames can arrive. */
export function isTerminalStatus(status: string | null | undefined): boolean {
  return (
    status === "completed" ||
    status === "rejected" ||
    status === "failed" ||
    status === "escalated"
  );
}
