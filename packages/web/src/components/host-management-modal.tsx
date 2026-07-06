import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { HostConfig } from '../shared/index.js';
import { Modal } from './modal.tsx';
import { inputCls, labelCls } from './form-styles.ts';
import { api, type HostInput, type ProbeResponse } from '../api.ts';
import { useToast } from './toast.tsx';
import { useT } from '../i18n/index.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
}

const REDACTED = '***';

interface FormState {
  hostname: string;
  port: string;
  alias: string;
  user: string;
  password: string;
}

const EMPTY_FORM: FormState = { hostname: '', port: '', alias: '', user: '', password: '' };

export function hostLabel(h: HostConfig): string {
  if (h.alias) return h.alias;
  const at = h.user ? `${h.user}@` : '';
  return `${at}${h.hostname}${h.port != null ? `:${h.port}` : ''}`;
}

export function HostManagementModal({ open, onClose }: Props) {
  const t = useT();
  const [hosts, setHosts] = useState<HostConfig[]>([]);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingHost, setEditingHost] = useState<HostConfig | null>(null);
  const [hadPassword, setHadPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ProbeResponse | null>(null);
  const [installingTmux, setInstallingTmux] = useState(false);
  const [tmuxInstall, setTmuxInstall] = useState<{ ok: boolean; message: string } | null>(null);
  const probeSeqRef = useRef(0);
  const probeAbortRef = useRef<AbortController | null>(null);
  const { show } = useToast();

  const refresh = useCallback(() => {
    api.hosts.list()
      .then(setHosts)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!open) {
      if (probeAbortRef.current) probeAbortRef.current.abort();
      return;
    }
    setView('list');
    setEditingId(null);
    setEditingHost(null);
    setForm(EMPTY_FORM);
    setError(null);
    refresh();
  }, [open, refresh]);

  useEffect(() => {
    probeSeqRef.current += 1;
    if (probeAbortRef.current) probeAbortRef.current.abort();
    setProbing(false);
    setProbeResult(null);
    setInstallingTmux(false);
    setTmuxInstall(null);
  }, [form.hostname, form.user, form.port, form.password, clearPassword, view]);

  useEffect(() => {
    return () => {
      if (probeAbortRef.current) probeAbortRef.current.abort();
    };
  }, []);

  const startAdd = () => {
    setEditingId(null);
    setEditingHost(null);
    setHadPassword(false);
    setClearPassword(false);
    setForm(EMPTY_FORM);
    setError(null);
    setView('form');
  };

  const startEdit = (h: HostConfig) => {
    setEditingId(h.id ?? null);
    setEditingHost(h);
    setHadPassword(h.password === REDACTED);
    setClearPassword(false);
    setForm({
      hostname: h.hostname,
      port: h.port != null ? String(h.port) : '',
      alias: h.alias ?? '',
      user: h.user ?? '',
      password: '',
    });
    setError(null);
    setView('form');
  };

  const buildInput = (): HostInput => {
    const input: HostInput = {
      hostname: form.hostname.trim(),
    };
    if (editingId) {
      input.port = form.port.trim() ? Number(form.port) : null;
      input.alias = form.alias.trim();
      input.user = form.user.trim();
    } else {
      if (form.port.trim()) input.port = Number(form.port);
      if (form.alias.trim()) input.alias = form.alias.trim();
      if (form.user.trim()) input.user = form.user.trim();
    }
    if (editingId && clearPassword) {
      input.password = '';
    } else if (form.password) {
      input.password = form.password;
    }
    return input;
  };

  const portTrimmed = form.port.trim();
  const portValid = portTrimmed === '' || (/^\d+$/.test(portTrimmed) && Number(portTrimmed) > 0 && Number(portTrimmed) <= 65535);
  const formValid = form.hostname.trim().length > 0 && portValid;

  const structureUnchanged = !!editingHost
    && form.hostname.trim() === editingHost.hostname
    && form.user.trim() === (editingHost.user ?? '')
    && form.port.trim() === (editingHost.port != null ? String(editingHost.port) : '');

  // 结构未变且未改密码时按 hostId 探测，让服务端复用已存密码（表单里拿不到明文）
  const probeTarget = (): { host?: HostConfig; hostId?: string } => {
    if (editingId && structureUnchanged && !form.password && !clearPassword) {
      return { hostId: editingId };
    }
    return {
      host: {
        hostname: form.hostname.trim(),
        ...(form.user.trim() ? { user: form.user.trim() } : {}),
        ...(portTrimmed ? { port: Number(portTrimmed) } : {}),
        ...(!clearPassword && form.password ? { password: form.password } : {}),
      },
    };
  };

  const handleProbe = async () => {
    if (!formValid || probing) return;
    if (probeAbortRef.current) probeAbortRef.current.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    const seq = probeSeqRef.current;
    setProbing(true);
    setProbeResult(null);
    setTmuxInstall(null);
    setError(null);
    try {
      const result = await api.agents.probe('remote', probeTarget(), { signal: controller.signal });
      if (controller.signal.aborted || probeSeqRef.current !== seq) return;
      setProbeResult(result);
    } catch (err) {
      if (controller.signal.aborted || probeSeqRef.current !== seq) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (probeSeqRef.current === seq) setProbing(false);
    }
  };

  const handleInstallTmux = async () => {
    if (installingTmux) return;
    const seq = probeSeqRef.current;
    setInstallingTmux(true);
    setTmuxInstall(null);
    setError(null);
    try {
      const result = await api.agents.installTmux('remote', probeTarget());
      if (probeSeqRef.current !== seq) return;
      setTmuxInstall({ ok: result.ok, message: result.message });
      setProbeResult(prev => (prev ? { ...prev, tmux: result.tmux } : prev));
    } catch (err) {
      if (probeSeqRef.current !== seq) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (probeSeqRef.current === seq) setInstallingTmux(false);
    }
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!formValid || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      if (editingId) {
        await api.hosts.update(editingId, buildInput());
        show({ kind: 'success', title: t.hostMgmt.updatedToastTitle(editingId) });
      } else {
        const result = await api.hosts.create(buildInput());
        show({ kind: 'success', title: t.hostMgmt.createdToastTitle(result.host.id!) });
      }
      refresh();
      setView('list');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (h: HostConfig) => {
    setError(null);
    try {
      await api.hosts.delete(h.id!);
      show({ kind: 'success', title: t.hostMgmt.deletedToastTitle(h.id!) });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const listFooter = (
    <button type="button" onClick={onClose} className="btn-secondary">{t.common.close}</button>
  );
  const formFooter = (
    <>
      <button type="button" onClick={() => setView('list')} disabled={submitting} className="btn-secondary">
        {t.hostMgmt.back}
      </button>
      <button type="submit" form="host-form" disabled={!formValid || submitting} className="btn-primary">
        {submitting ? t.common.saving : t.common.save}
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.hostMgmt.title}
      size="md"
      footer={view === 'list' ? listFooter : formFooter}
    >
      {error && (
        <div className="mb-3 rounded-md border border-accent/25 bg-accent-soft px-3 py-2 text-sm text-accent">
          {error}
        </div>
      )}

      {view === 'list' ? (
        <div className="space-y-3">
          {hosts.length === 0 ? (
            <p className="text-sm text-og-500">{t.hostMgmt.emptyState}</p>
          ) : (
            <ul className="space-y-1.5">
              {hosts.map(h => (
                <li
                  key={h.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-og-100 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium text-og-800">{hostLabel(h)}</div>
                    <div className="truncate text-xs text-og-500">
                      {(h.user ? `${h.user}@` : '') + h.hostname}{h.port != null ? `:${h.port}` : ''}
                      {h.password === REDACTED ? t.hostMgmt.passwordSavedIndicator : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => startEdit(h)}
                      className="text-xs text-accent transition-colors hover:text-accent-hover">
                      {t.hostMgmt.edit}
                    </button>
                    <button type="button" onClick={() => handleDelete(h)}
                      className="text-xs text-accent transition-colors hover:opacity-80">
                      {t.common.delete}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={startAdd} className="btn-secondary w-full">{t.hostMgmt.addHostButton}</button>
        </div>
      ) : (
        <form id="host-form" onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className={labelCls} htmlFor="host-hostname">{t.hostMgmt.addressLabel}</label>
            <input id="host-hostname" type="text" value={form.hostname}
              onChange={e => setForm({ ...form, hostname: e.target.value })}
              className={inputCls} placeholder="remote.example.com" disabled={submitting} />
          </div>
          <div>
            <label className={labelCls} htmlFor="host-port">{t.hostMgmt.portLabel}</label>
            <input id="host-port" type="text" inputMode="numeric" value={form.port}
              onChange={e => setForm({ ...form, port: e.target.value })}
              className={inputCls} placeholder="22" disabled={submitting} />
            {form.port.trim() !== '' && !portValid && (
              <div className="mt-1 text-xs text-accent">{t.hostMgmt.portRangeError}</div>
            )}
          </div>
          <div>
            <label className={labelCls} htmlFor="host-alias">{t.hostMgmt.aliasLabel}</label>
            <input id="host-alias" type="text" value={form.alias}
              onChange={e => setForm({ ...form, alias: e.target.value })}
              className={inputCls} placeholder="Prod worker" disabled={submitting} />
          </div>
          <div>
            <label className={labelCls} htmlFor="host-user">{t.hostMgmt.userLabel}</label>
            <input id="host-user" type="text" value={form.user}
              onChange={e => setForm({ ...form, user: e.target.value })}
              className={inputCls} placeholder={t.hostMgmt.userPlaceholder} disabled={submitting} />
          </div>
          <div>
            <label className={labelCls} htmlFor="host-password">{t.hostMgmt.passwordLabel}</label>
            <input id="host-password" type="password" value={clearPassword ? '' : form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              className={inputCls}
              placeholder={hadPassword ? t.hostMgmt.passwordPlaceholderSet : t.hostMgmt.passwordPlaceholderUnset}
              disabled={submitting || clearPassword} autoComplete="new-password" />
            {editingId && hadPassword && (
              <label className="mt-1.5 flex items-center gap-2 text-xs text-og-700">
                <input type="checkbox" className="h-3.5 w-3.5 accent-accent" checked={clearPassword}
                  onChange={e => setClearPassword(e.target.checked)} disabled={submitting} />
                {t.hostMgmt.clearPasswordLabel}
              </label>
            )}
          </div>

          <div className="rounded-md border border-accent/25 bg-accent-soft/60 px-3 py-2.5 text-xs text-accent">
            {t.hostMgmt.passwordHintLead}<strong className="font-semibold">{t.hostMgmt.passwordHintStrong}</strong>{' '}
            {t.hostMgmt.plaintextWarningLead}<strong className="font-semibold">{t.hostMgmt.plaintextWarningStrong}</strong>{t.hostMgmt.plaintextWarningTrail}
          </div>

          <div className="space-y-1.5">
            <button type="button" onClick={handleProbe} disabled={!formValid || probing || submitting || installingTmux}
              className="text-xs text-accent transition-colors hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
              {probing ? t.hostMgmt.testing : t.hostMgmt.testConnection}
            </button>
            {probeResult?.ssh && (
              <div className={`text-xs ${probeResult.ssh.ok ? 'text-og-800' : 'text-accent'}`}>
                SSH: {probeResult.ssh.ok ? '✓' : '⨯'} {probeResult.ssh.message}
              </div>
            )}
            {probeResult && (
              probeResult.tmux.ok ? (
                <div className="text-xs text-og-800">tmux: ✓ {probeResult.tmux.path ?? ''}</div>
              ) : (
                <div className="text-xs text-accent">
                  tmux: ⨯ {probeResult.tmux.message}
                  {probeResult.ssh?.ok && (
                    <button type="button" onClick={handleInstallTmux} disabled={installingTmux || submitting}
                      className="ml-2 text-accent underline transition-colors hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                      {installingTmux ? t.common.installing : t.common.oneClickInstall}
                    </button>
                  )}
                </div>
              )
            )}
            {installingTmux && (
              <div className="text-xs text-og-500">{t.common.installingTmuxNotice}</div>
            )}
            {!installingTmux && tmuxInstall && (
              <div className={`break-all text-xs ${tmuxInstall.ok ? 'text-og-800' : 'text-accent'}`}>
                {tmuxInstall.ok ? '✓ ' : '⨯ '}{tmuxInstall.message}
              </div>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
