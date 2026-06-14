import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { HostConfig } from '../shared/index.js';
import { Modal } from './modal.tsx';
import { api, type HostInput } from '../api.ts';
import { useToast } from './toast.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
}

const REDACTED = '***';
const inputCls =
  'w-full rounded-md border border-og-100 bg-surface px-2.5 py-1.5 text-[13px] text-og-800 placeholder:text-og-400 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50';
const labelCls = 'mb-1.5 block text-[12px] font-medium text-og-700';

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
  const [hosts, setHosts] = useState<HostConfig[]>([]);
  const [view, setView] = useState<'list' | 'form'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [hadPassword, setHadPassword] = useState(false);
  const [clearPassword, setClearPassword] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { show } = useToast();

  const refresh = useCallback(() => {
    api.hosts.list()
      .then(setHosts)
      .catch(err => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  useEffect(() => {
    if (!open) return;
    setView('list');
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setTestResult(null);
    refresh();
  }, [open, refresh]);

  const startAdd = () => {
    setEditingId(null);
    setHadPassword(false);
    setClearPassword(false);
    setForm(EMPTY_FORM);
    setError(null);
    setTestResult(null);
    setView('form');
  };

  const startEdit = (h: HostConfig) => {
    setEditingId(h.id ?? null);
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
    setTestResult(null);
    setView('form');
  };

  const buildInput = (): HostInput => {
    const input: HostInput = {
      hostname: form.hostname.trim(),
    };
    // On edit, send alias/user/port explicitly so a blank CLEARS — PATCH treats an omitted field as
    // "keep current", so omitting would silently revert. Port clears with null ('' isn't a number),
    // letting a host wrongly saved as 22 fall back to ~/.ssh/config. On create, omit empties.
    if (editingId) {
      input.port = form.port.trim() ? Number(form.port) : null;
      input.alias = form.alias.trim();
      input.user = form.user.trim();
    } else {
      if (form.port.trim()) input.port = Number(form.port);
      if (form.alias.trim()) input.alias = form.alias.trim();
      if (form.user.trim()) input.user = form.user.trim();
    }
    // Password is opt-in to change: empty field = keep current. An explicit "clear" sends '' so the
    // server drops the stored secret (switch a host back to key auth); a typed value sets a new one.
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

  const handleTest = async () => {
    if (!formValid) return;
    setTesting(true);
    setTestResult(null);
    setError(null);
    try {
      const result = await api.hosts.check({ ...buildInput(), ...(editingId ? { id: editingId } : {}) });
      setTestResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setTesting(false);
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
        show({ kind: 'success', title: `Host ${editingId} 已更新` });
      } else {
        const result = await api.hosts.create(buildInput());
        show({ kind: 'success', title: `Host ${result.host.id} 已添加` });
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
      show({ kind: 'success', title: `Host ${h.id} 已删除` });
      refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const listFooter = (
    <button type="button" onClick={onClose} className="btn-secondary">关闭</button>
  );
  const formFooter = (
    <>
      <button type="button" onClick={() => setView('list')} disabled={submitting} className="btn-secondary">
        返回
      </button>
      <button type="submit" form="host-form" disabled={!formValid || submitting} className="btn-primary">
        {submitting ? '保存中…' : '保存'}
      </button>
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Host 管理"
      size="md"
      footer={view === 'list' ? listFooter : formFooter}
    >
      {error && (
        <div className="mb-3 rounded-md border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[13px] text-danger">
          {error}
        </div>
      )}

      {view === 'list' ? (
        <div className="space-y-3">
          {hosts.length === 0 ? (
            <p className="text-[13px] text-og-500">还没有配置 Host。点击下方「添加 Host」。</p>
          ) : (
            <ul className="space-y-1.5">
              {hosts.map(h => (
                <li
                  key={h.id}
                  className="flex items-center justify-between gap-3 rounded-md border border-og-100 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-og-800">{hostLabel(h)}</div>
                    <div className="truncate text-[12px] text-og-500">
                      {(h.user ? `${h.user}@` : '') + h.hostname}{h.port != null ? `:${h.port}` : ''}
                      {h.password === REDACTED ? ' · 密码已保存' : ''}
                    </div>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => startEdit(h)}
                      className="text-[12px] text-accent transition-colors hover:text-accent-hover">
                      编辑
                    </button>
                    <button type="button" onClick={() => handleDelete(h)}
                      className="text-[12px] text-danger transition-colors hover:opacity-80">
                      删除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={startAdd} className="btn-secondary w-full">+ 添加 Host</button>
        </div>
      ) : (
        <form id="host-form" onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className={labelCls} htmlFor="host-hostname">Host 地址</label>
            <input id="host-hostname" type="text" value={form.hostname}
              onChange={e => setForm({ ...form, hostname: e.target.value })}
              className={inputCls} placeholder="remote.example.com" disabled={submitting} />
          </div>
          <div>
            <label className={labelCls} htmlFor="host-port">端口（可选）</label>
            <input id="host-port" type="text" inputMode="numeric" value={form.port}
              onChange={e => setForm({ ...form, port: e.target.value })}
              className={inputCls} placeholder="22" disabled={submitting} />
            {form.port.trim() !== '' && !portValid && (
              <div className="mt-1 text-[12px] text-danger">端口需为 1–65535 的整数</div>
            )}
          </div>
          <div>
            <label className={labelCls} htmlFor="host-alias">别名（可选）</label>
            <input id="host-alias" type="text" value={form.alias}
              onChange={e => setForm({ ...form, alias: e.target.value })}
              className={inputCls} placeholder="Prod worker" disabled={submitting} />
          </div>
          <div>
            <label className={labelCls} htmlFor="host-user">用户名（可选）</label>
            <input id="host-user" type="text" value={form.user}
              onChange={e => setForm({ ...form, user: e.target.value })}
              className={inputCls} placeholder="留空则读 ~/.ssh/config 的 User" disabled={submitting} />
          </div>
          <div>
            <label className={labelCls} htmlFor="host-password">密码（可选）</label>
            <input id="host-password" type="password" value={clearPassword ? '' : form.password}
              onChange={e => setForm({ ...form, password: e.target.value })}
              className={inputCls}
              placeholder={hadPassword ? '已设置，留空保持不变' : '留空使用 key 认证'}
              disabled={submitting || clearPassword} autoComplete="new-password" />
            {editingId && hadPassword && (
              <label className="mt-1.5 flex items-center gap-2 text-[12px] text-og-700">
                <input type="checkbox" className="h-3.5 w-3.5 accent-[#1348dc]" checked={clearPassword}
                  onChange={e => setClearPassword(e.target.checked)} disabled={submitting} />
                清除已保存的密码（改用 key 登录）
              </label>
            )}
          </div>

          <div className="rounded-md border border-[#fde68a] bg-[#fef3c7]/60 px-3 py-2.5 text-[12px] text-warn">
            建议为该 Host 配置好<strong className="font-semibold">免密码登入（SSH key）</strong>。
            否则填写的密码将以<strong className="font-semibold">明文</strong>保存到 baxian.json 中。
          </div>

          <div className="flex items-center gap-3">
            <button type="button" onClick={handleTest} disabled={!formValid || testing || submitting}
              className="text-[12px] text-accent transition-colors hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
              {testing ? '测试中…' : '测试连接'}
            </button>
            {testResult && (
              <span className={`text-[12px] ${testResult.ok ? 'text-success' : 'text-danger'}`}>
                {testResult.ok ? '✓ ' : '⨯ '}{testResult.message}
              </span>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}
