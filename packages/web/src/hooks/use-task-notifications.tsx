import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';

const STORAGE_KEY = 'baxian.taskNotifications.enabled';

export type TaskNotificationPermission = NotificationPermission | 'unsupported';

export function notificationApi(): typeof Notification | null {
  if (typeof window === 'undefined') return null;
  const candidate = (window as Window & { Notification?: typeof Notification }).Notification;
  return typeof candidate === 'function' ? candidate : null;
}

function notificationPermission(): TaskNotificationPermission {
  const apiRef = notificationApi();
  return apiRef ? apiRef.permission : 'unsupported';
}

function readPreference(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    return true;
  }
}

function persistPreference(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
  }
}

interface TaskNotificationsContextValue {
  permission: TaskNotificationPermission;
  preferenceEnabled: boolean;
  enabled: boolean;
  requesting: boolean;
  enable: () => void;
  disable: () => void;
}

const TaskNotificationsContext = createContext<TaskNotificationsContextValue | null>(null);

export function TaskNotificationsProvider({ children }: { children: ReactNode }) {
  const [permission, setPermission] = useState<TaskNotificationPermission>(notificationPermission);
  const [preferenceEnabled, setPreferenceEnabled] = useState(readPreference);
  const [requesting, setRequesting] = useState(false);
  const requestInFlight = useRef(false);
  const disableEpoch = useRef(0);

  useEffect(() => {
    const onFocus = () => {
      setPermission(notificationPermission());
      // 自身授权请求 pending 期间存储值尚未写入(见 enable),回读会吃掉本次开启意图
      if (!requestInFlight.current) setPreferenceEnabled(readPreference());
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== STORAGE_KEY) return;
      setPermission(notificationPermission());
      // storage 事件异步排队,可能滞后于当前存储值:关闭动作必须按事件自身的 newValue 记录,
      // 回读会把滞后的关闭事件误判成开启;仅 clear(key===null)场景回读当前值
      const stored = e.key === null ? readPreference() : e.newValue !== '0';
      if (!stored) disableEpoch.current += 1;
      setPreferenceEnabled(stored);
    };
    window.addEventListener('focus', onFocus);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const enable = useCallback(() => {
    setPreferenceEnabled(true);
    const apiRef = notificationApi();
    if (!apiRef) {
      persistPreference(true);
      return;
    }
    if (apiRef.permission !== 'default') {
      setPermission(apiRef.permission);
      persistPreference(true);
      return;
    }
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setRequesting(true);
    const intentEpoch = disableEpoch.current;
    void apiRef.requestPermission()
      .then(setPermission)
      .catch((err) => {
        console.warn('[task-notifications] permission request failed:', err);
        setPermission(notificationPermission());
      })
      .finally(() => {
        // 授权结束后才持久化(其他标签页收到 storage 同步时权限已定型),
        // 且仅当期间没有更新的关闭操作,过期授权不得复活开启
        if (disableEpoch.current === intentEpoch) persistPreference(true);
        requestInFlight.current = false;
        setRequesting(false);
      });
  }, []);

  const disable = useCallback(() => {
    disableEpoch.current += 1;
    setPreferenceEnabled(false);
    persistPreference(false);
  }, []);

  return (
    <TaskNotificationsContext.Provider
      value={{
        permission,
        preferenceEnabled,
        enabled: permission === 'granted' && preferenceEnabled,
        requesting,
        enable,
        disable,
      }}
    >
      {children}
    </TaskNotificationsContext.Provider>
  );
}

export function useTaskNotifications(): TaskNotificationsContextValue {
  const ctx = useContext(TaskNotificationsContext);
  if (!ctx) {
    throw new Error('useTaskNotifications must be used inside TaskNotificationsProvider');
  }
  return ctx;
}
