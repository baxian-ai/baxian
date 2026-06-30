import { useEffect, useState } from 'react';
import type { AgentSnapshot, TaskState } from '../shared/index.js';
import { getEventsClient } from '../stores/events-store.ts';
import { api } from '../api.ts';

export interface EventsResult<T> {
  data: T | null;
  loaded: boolean;
  error: { code: string; message: string } | null;
}

export function useAgents(): EventsResult<AgentSnapshot[]> {
  const [data, setData] = useState<AgentSnapshot[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    const unsub = getEventsClient().subscribe<AgentSnapshot[]>(
      'agents',
      (next) => {
        setError(null);
        setData(next);
        setLoaded(true);
      },
      (err) => setError(err),
    );
    return unsub;
  }, []);
  return { data, loaded, error };
}

export function useAgent(agentId: string): EventsResult<AgentSnapshot> {
  const [data, setData] = useState<AgentSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    setData(null);
    setLoaded(false);
    setError(null);
    const unsub = getEventsClient().subscribe<AgentSnapshot | null>(
      `agent:${agentId}`,
      (next) => {
        setError(null);
        setData(next);
        setLoaded(true);
      },
      (err) => setError(err),
    );
    return unsub;
  }, [agentId]);
  return { data, loaded, error };
}

export function useTask(taskId: string): EventsResult<TaskState> {
  const [data, setData] = useState<TaskState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    setData(null);
    setLoaded(false);
    setError(null);
    const unsub = getEventsClient().subscribe<TaskState | null>(
      `task:${taskId}`,
      (next) => {
        setError(null);
        setData(next);
        setLoaded(true);
      },
      (err) => setError(err),
    );
    return unsub;
  }, [taskId]);
  return { data, loaded, error };
}

export function useProjectTasks(projectId: string | undefined): EventsResult<TaskState[]> {
  const [data, setData] = useState<TaskState[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  useEffect(() => {
    if (!projectId) {
      setData(null);
      setLoaded(false);
      setError(null);
      return;
    }
    setData(null);
    setLoaded(false);
    setError(null);

    let cancelled = false;
    let wsLanded = false;
    let restAttempted = false;

    const unsub = getEventsClient().subscribe<TaskState[]>(
      `project-tasks:${projectId}`,
      (next) => {
        if (cancelled) return;
        wsLanded = true;
        setError(null);
        setData(next);
        setLoaded(true);
      },
      (err) => {
        if (cancelled) return;
        setError(err);
        if (wsLanded || restAttempted) return;
        restAttempted = true;
        void api.tasks.list(projectId).then(
          (rest) => {
            if (cancelled || wsLanded) return;
            setData(rest);
            setLoaded(true);
          },
          (restErr) => {
            console.warn(`[useProjectTasks] REST fallback failed for ${projectId}:`, restErr);
          },
        );
      },
    );

    return () => {
      cancelled = true;
      unsub();
    };
  }, [projectId]);
  return { data, loaded, error };
}
