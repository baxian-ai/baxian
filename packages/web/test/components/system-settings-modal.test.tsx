import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactElement } from 'react';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { toastShowMock } from '../helpers/toast-mock.tsx';
import { SystemSettingsModal } from '../../src/components/system-settings-modal.tsx';
import { TaskNotificationsProvider } from '../../src/hooks/use-task-notifications.tsx';
import { I18nProvider, __resetI18nForTests } from '../../src/i18n/index.tsx';

const configPatchMock = vi.mocked(api.config.patch);
const showMock = toastShowMock;

const originalNotification = window.Notification;

function installNotificationMock(permission: NotificationPermission) {
  const requestPermission = vi.fn<() => Promise<NotificationPermission>>();
  class MockNotification {
    static permission = permission;
    static requestPermission = requestPermission;
  }
  Object.defineProperty(window, 'Notification', { configurable: true, value: MockNotification });
  return { requestPermission, MockNotification };
}

function restoreNotification(): void {
  Object.defineProperty(window, 'Notification', { configurable: true, value: originalNotification });
}

function renderModal(withI18n = false) {
  const body: ReactElement = (
    <TaskNotificationsProvider>
      <SystemSettingsModal open onClose={() => {}} />
    </TaskNotificationsProvider>
  );
  return render(withI18n ? <I18nProvider>{body}</I18nProvider> : body);
}

beforeEach(() => {
  cleanup();
  configPatchMock.mockReset();
  showMock.mockReset();
  restoreNotification();
  localStorage.clear();
});

afterEach(() => {
  __resetI18nForTests();
});

describe('SystemSettingsModal', () => {
  it('renders both language options with English selected by default when there is no I18nProvider', () => {
    renderModal();

    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
    const english = screen.getByRole('radio', { name: 'English' }) as HTMLInputElement;
    const chinese = screen.getByRole('radio', { name: '简体中文' }) as HTMLInputElement;
    expect(english.checked).toBe(true);
    expect(chinese.checked).toBe(false);
  });

  it('switches to 简体中文 by patching config, then flips the modal title to 系统设置', async () => {
    configPatchMock.mockResolvedValue({
      config: { language: 'zh-CN', review: { rounds: 3 }, server: { port: 0 }, host: [], project: [] },
      restartRequired: false,
      note: '',
    });
    renderModal(true);

    fireEvent.click(screen.getByRole('radio', { name: '简体中文' }));

    await waitFor(() => expect(configPatchMock).toHaveBeenCalledWith({ language: 'zh-CN' }));
    await waitFor(() => expect(screen.getByRole('dialog', { name: '系统设置' })).toBeTruthy());
  });

  it('shows a "Failed to save language:" toast and keeps English selected when the PATCH rejects', async () => {
    configPatchMock.mockRejectedValueOnce(new Error('boom'));
    renderModal(true);

    fireEvent.click(screen.getByRole('radio', { name: '简体中文' }));

    await waitFor(() => expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to save language: boom' }));
    expect((screen.getByRole('radio', { name: 'English' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('dialog', { name: 'Settings' })).toBeTruthy();
  });

  describe('task notifications', () => {
    const STORAGE_KEY = 'baxian.taskNotifications.enabled';

    function getCheckbox(): HTMLInputElement {
      return screen.getByRole('checkbox', { name: 'Task completion notifications' }) as HTMLInputElement;
    }

    it('shows an enabled, checked checkbox when permission is granted', () => {
      installNotificationMock('granted');
      renderModal();

      const checkbox = screen.getByRole('checkbox', { name: 'Task completion notifications' }) as HTMLInputElement;
      expect(checkbox.checked).toBe(true);
      expect(checkbox.disabled).toBe(false);
    });

    it('disables the checkbox and shows the blocked hint when permission is denied', () => {
      installNotificationMock('denied');
      renderModal();

      const checkbox = screen.getByRole('checkbox', { name: 'Task completion notifications' }) as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
      expect(screen.getByText('Notifications are blocked by the browser')).toBeTruthy();
    });

    it('renders no notification checkbox or hint when the browser has no Notification API, while the language section still renders', () => {
      renderModal();

      expect(screen.queryByRole('checkbox', { name: 'Task completion notifications' })).toBeNull();
      expect(screen.queryByText('Notifications are blocked by the browser')).toBeNull();
      expect(screen.queryByText('Notify via the browser when a task reaches done or merged')).toBeNull();
      expect(screen.getByRole('radio', { name: 'English' })).toBeTruthy();
    });

    it('starts with the checkbox unchecked when permission is granted but the stored preference is off', () => {
      installNotificationMock('granted');
      localStorage.setItem(STORAGE_KEY, '0');
      renderModal();

      expect(getCheckbox().checked).toBe(false);
    });

    it('toggles the stored preference on and off by clicking the checkbox when permission is already granted, without calling requestPermission', () => {
      const notification = installNotificationMock('granted');
      renderModal();

      fireEvent.click(getCheckbox());
      expect(getCheckbox().checked).toBe(false);
      expect(localStorage.getItem(STORAGE_KEY)).toBe('0');

      fireEvent.click(getCheckbox());
      expect(getCheckbox().checked).toBe(true);
      expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
      expect(notification.requestPermission).not.toHaveBeenCalled();
    });

    it('disables the checkbox while the permission request is pending, then checks it and persists the preference only once permission is granted', async () => {
      const notification = installNotificationMock('default');
      let resolveRequest: (permission: NotificationPermission) => void = () => {};
      notification.requestPermission.mockImplementation(
        () => new Promise<NotificationPermission>((resolve) => { resolveRequest = resolve; }),
      );
      renderModal();

      fireEvent.click(getCheckbox());
      expect(notification.requestPermission).toHaveBeenCalledTimes(1);
      expect(getCheckbox().disabled).toBe(true);
      expect(getCheckbox().checked).toBe(false);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

      await act(async () => {
        notification.MockNotification.permission = 'granted';
        resolveRequest('granted');
        await Promise.resolve();
      });

      expect(getCheckbox().disabled).toBe(false);
      expect(getCheckbox().checked).toBe(true);
      expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
    });

    it('keeps a disable from another tab in effect when a pending permission request later resolves granted, instead of resurrecting the stale enable', async () => {
      const notification = installNotificationMock('default');
      let resolveRequest: (permission: NotificationPermission) => void = () => {};
      notification.requestPermission.mockImplementation(
        () => new Promise<NotificationPermission>((resolve) => { resolveRequest = resolve; }),
      );
      renderModal();

      fireEvent.click(getCheckbox());
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

      act(() => {
        localStorage.setItem(STORAGE_KEY, '0');
        window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: '0' }));
      });

      await act(async () => {
        notification.MockNotification.permission = 'granted';
        resolveRequest('granted');
        await Promise.resolve();
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe('0');
      expect(getCheckbox().checked).toBe(false);
    });

    it('does not let a window focus event during a pending permission request clobber the enable intent', async () => {
      const notification = installNotificationMock('default');
      localStorage.setItem(STORAGE_KEY, '0');
      let resolveRequest: (permission: NotificationPermission) => void = () => {};
      notification.requestPermission.mockImplementation(
        () => new Promise<NotificationPermission>((resolve) => { resolveRequest = resolve; }),
      );
      renderModal();

      fireEvent.click(getCheckbox());

      act(() => {
        window.dispatchEvent(new Event('focus'));
      });

      await act(async () => {
        notification.MockNotification.permission = 'granted';
        resolveRequest('granted');
        await Promise.resolve();
      });

      expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
      expect(getCheckbox().checked).toBe(true);
    });

    it('enables directly without calling requestPermission when the browser permission was already granted elsewhere after mount', () => {
      const notification = installNotificationMock('default');
      renderModal();

      notification.MockNotification.permission = 'granted';
      fireEvent.click(getCheckbox());

      expect(notification.requestPermission).not.toHaveBeenCalled();
      expect(getCheckbox().checked).toBe(true);
      expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
    });

    it('re-reads the live Notification.permission on a storage event, not just the stored preference', () => {
      const notification = installNotificationMock('default');
      renderModal();

      expect(getCheckbox().checked).toBe(false);

      notification.MockNotification.permission = 'granted';
      act(() => {
        localStorage.setItem(STORAGE_KEY, '1');
        window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: '1' }));
      });

      expect(getCheckbox().checked).toBe(true);
    });

    it('trusts a storage event\'s own newValue for the preference over a stale localStorage read, for both a disable and a later enable', () => {
      installNotificationMock('granted');
      localStorage.setItem(STORAGE_KEY, '1');
      renderModal();

      expect(getCheckbox().checked).toBe(true);

      act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: '0' }));
      });
      expect(getCheckbox().checked).toBe(false);

      act(() => {
        window.dispatchEvent(new StorageEvent('storage', { key: STORAGE_KEY, newValue: '1' }));
      });
      expect(getCheckbox().checked).toBe(true);
    });

    it('re-reads the stored preference from localStorage on a window focus event', () => {
      installNotificationMock('granted');
      renderModal();

      expect(getCheckbox().checked).toBe(true);

      act(() => {
        localStorage.setItem(STORAGE_KEY, '0');
        window.dispatchEvent(new Event('focus'));
      });

      expect(getCheckbox().checked).toBe(false);
    });
  });
});
