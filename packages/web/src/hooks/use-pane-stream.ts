import { useCallback, useEffect, useRef } from 'react';
import type { StreamSubMode } from '../shared/index.js';
import {
  getPaneStreamClient,
  type SnapshotPayload,
  type StreamErrorPayload,
} from '../stores/pane-stream-store.ts';

export interface UsePaneStreamArgs {
  agentId: string;
  mode: StreamSubMode;
  onSnapshot: (msg: SnapshotPayload) => void;
  onData: (data: string) => void;
  onError?: (msg: StreamErrorPayload) => void;
  onSessionGone?: () => void;
}

export interface UsePaneStreamApi {
  send: (data: string) => void;
  resize: (cols: number, rows: number) => void;
}

export function usePaneStream(args: UsePaneStreamArgs): UsePaneStreamApi {
  const { agentId, mode } = args;
  const subscriberIdRef = useRef<string | null>(null);

  const callbacksRef = useRef({
    onSnapshot: args.onSnapshot,
    onData: args.onData,
    onError: args.onError,
    onSessionGone: args.onSessionGone,
  });
  callbacksRef.current = {
    onSnapshot: args.onSnapshot,
    onData: args.onData,
    onError: args.onError,
    onSessionGone: args.onSessionGone,
  };

  useEffect(() => {
    const client = getPaneStreamClient();
    const handle = client.subscribe({
      agentId,
      mode,
      onSnapshot: (msg) => callbacksRef.current.onSnapshot(msg),
      onData: (data) => callbacksRef.current.onData(data),
      onError: (msg) => callbacksRef.current.onError?.(msg),
      onSessionGone: () => callbacksRef.current.onSessionGone?.(),
    });
    subscriberIdRef.current = handle.subscriberId;
    return () => {
      subscriberIdRef.current = null;
      handle.unsubscribe();
    };
  }, [agentId, mode]);

  const send = useCallback((data: string) => {
    const sid = subscriberIdRef.current;
    if (sid) getPaneStreamClient().send(sid, data);
  }, []);

  const resize = useCallback((cols: number, rows: number) => {
    const sid = subscriberIdRef.current;
    if (sid) getPaneStreamClient().resize(sid, cols, rows);
  }, []);

  return { send, resize };
}
