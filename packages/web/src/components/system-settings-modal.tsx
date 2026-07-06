import { Modal } from './modal.tsx';
import { useI18n, useT } from '../i18n/index.tsx';
import { useTaskNotifications } from '../hooks/use-task-notifications.tsx';
import { useToast } from './toast.tsx';
import { labelCls, helpCls, radioCls } from './form-styles.ts';
import type { SupportedLanguage } from '../shared/index.js';

const LANGUAGE_OPTIONS: Array<{ value: SupportedLanguage; label: string }> = [
  { value: 'en-US', label: 'English' },
  { value: 'zh-CN', label: '简体中文' },
];

export function SystemSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const { locale, saving, setLocale } = useI18n();
  const { show } = useToast();

  const pick = async (next: SupportedLanguage) => {
    try {
      await setLocale(next);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      show({ kind: 'error', title: t.settings.languageSaveFailed(detail) });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={t.settings.title} size="sm">
      <div className="space-y-5">
        <fieldset>
          <legend className={labelCls}>{t.settings.language}</legend>
          <div className="flex gap-4">
            {LANGUAGE_OPTIONS.map((option) => (
              <label key={option.value} className="inline-flex items-center gap-2 text-sm text-og-800">
                <input
                  type="radio"
                  name="baxian-language"
                  className={radioCls}
                  checked={locale === option.value}
                  disabled={saving}
                  onChange={() => void pick(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
        <TaskNotificationsSetting />
      </div>
    </Modal>
  );
}

function TaskNotificationsSetting() {
  const t = useT();
  const { permission, enabled, requesting, enable, disable } = useTaskNotifications();
  if (permission === 'unsupported') return null;
  const denied = permission === 'denied';
  return (
    <div>
      <label className="inline-flex items-center gap-2 text-sm text-og-800">
        <input
          type="checkbox"
          className={radioCls}
          checked={enabled}
          disabled={denied || requesting}
          onChange={() => (enabled ? disable() : enable())}
        />
        {t.settings.taskNotifications}
      </label>
      <p className={helpCls}>{denied ? t.settings.taskNotificationsDenied : t.settings.taskNotificationsHint}</p>
    </div>
  );
}
