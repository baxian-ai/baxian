import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentMode, AgentRuntime, AgentRole, ProjectConfig, AgentConfig, HostConfig } from '../shared/index.js';
import { Modal } from './modal.tsx';
import { inputCls, labelCls, fieldErrCls, helpCls, radioCls } from './form-styles.ts';
import { api, type ProbeResponse, type AddAgentBody } from '../api.ts';
import { useToast } from './toast.tsx';
import { usePendingRestart } from '../hooks/use-pending-restart.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onCreated: () => void;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const PROBE_DEBOUNCE_MS = 500;


interface FormState {
  id: string;
  role: AgentRole;
  pairWith: string;
  mode: AgentMode;
  host: string;
  runtime: AgentRuntime | '';
  workdir: string;
  yolo: boolean;
  model: string;
  addDirs: string;
}

const INITIAL_FORM: FormState = {
  id: '', role: 'dev', pairWith: '',
  mode: 'local', host: '',
  runtime: '', workdir: '', yolo: true,
  model: '', addDirs: '',
};

function hostLabel(h: HostConfig): string {
  if (h.alias) return h.alias;
  return `${h.user ? `${h.user}@` : ''}${h.hostname}${h.port != null ? `:${h.port}` : ''}`;
}

export function CreateAgentModal({ open, onClose, projectId, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(INITIAL_FORM);
  const [project, setProject] = useState<ProjectConfig | null>(null);
  const [hosts, setHosts] = useState<HostConfig[]>([]);
  const [allAgentIds, setAllAgentIds] = useState<Set<string>>(new Set());
  const [probe, setProbe] = useState<ProbeResponse | null>(null);
  const [probeLoading, setProbeLoading] = useState(false);
  const [installingTmux, setInstallingTmux] = useState(false);
  const [tmuxInstall, setTmuxInstall] = useState<{ ok: boolean; message: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const probeAbortRef = useRef<AbortController | null>(null);
  const probeDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const installSeqRef = useRef(0);
  const sessionRef = useRef(0);
  const { show } = useToast();
  const { flagDirty } = usePendingRestart();

  useEffect(() => {
    if (!open) return;
    sessionRef.current += 1;
    const session = sessionRef.current;
    setForm(INITIAL_FORM);
    setProject(null);
    setHosts([]);
    setAllAgentIds(new Set());
    setProbe(null);
    setProbeLoading(false);
    setInstallingTmux(false);
    setTmuxInstall(null);
    installSeqRef.current += 1;
    setError(null);
    setShowAdvanced(false);

    api.config.get().then(cfg => {
      if (session !== sessionRef.current) return;
      const proj = cfg.project.find(p => p.id === projectId) ?? null;
      setProject(proj);
      setHosts(cfg.host ?? []);
      const ids = new Set<string>();
      cfg.project.forEach(p => p.agent.forEach(pair => pair.forEach(a => ids.add(a.id))));
      setAllAgentIds(ids);
    }).catch(() => {});
  }, [open, projectId]);

  const handleDismiss = () => {
    if (submitting) return;
    onClose();
  };

  const runProbe = useCallback(() => {
    if (probeAbortRef.current) probeAbortRef.current.abort();
    const controller = new AbortController();
    probeAbortRef.current = controller;
    setProbeLoading(true);
    setError(null);
    const target = form.mode === 'remote' ? { hostId: form.host } : {};
    api.agents.probe(form.mode, target, { signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) return;
        setProbe(result);
        setError(null);
      })
      .catch(err => {
        if (controller.signal.aborted) return;
        setProbe(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (probeAbortRef.current === controller) setProbeLoading(false);
      });
  }, [form.mode, form.host]);

  useEffect(() => {
    if (!open) return;
    setProbe(null);
    setTmuxInstall(null);
    setInstallingTmux(false);
    installSeqRef.current += 1;
    if (probeAbortRef.current) probeAbortRef.current.abort();
    if (form.mode === 'remote' && !form.host) return;
    if (probeDebounceRef.current) clearTimeout(probeDebounceRef.current);
    probeDebounceRef.current = setTimeout(runProbe, PROBE_DEBOUNCE_MS);
    return () => {
      if (probeDebounceRef.current) clearTimeout(probeDebounceRef.current);
    };
  }, [open, form.mode, form.host, runProbe]);

  useEffect(() => {
    if (open) return;
    if (probeAbortRef.current) probeAbortRef.current.abort();
  }, [open]);

  useEffect(() => {
    return () => {
      if (probeAbortRef.current) probeAbortRef.current.abort();
      if (probeDebounceRef.current) clearTimeout(probeDebounceRef.current);
    };
  }, []);

  const handleInstallTmux = () => {
    if (installingTmux) return;
    const seq = installSeqRef.current;
    setInstallingTmux(true);
    setTmuxInstall(null);
    const target = form.mode === 'remote' ? { hostId: form.host } : {};
    api.agents.installTmux(form.mode, target)
      .then(result => {
        if (installSeqRef.current !== seq) return;
        setTmuxInstall({ ok: result.ok, message: result.message });
        setInstallingTmux(false);
        if (result.ok) runProbe();
      })
      .catch(err => {
        if (installSeqRef.current !== seq) return;
        setTmuxInstall({ ok: false, message: err instanceof Error ? err.message : String(err) });
        setInstallingTmux(false);
      });
  };

  const unpairedDevs: AgentConfig[] = project?.agent
    .filter(pair => pair.length === 1 && pair[0].role === 'dev')
    .map(pair => pair[0]) ?? [];

  const canSelectQa = unpairedDevs.length > 0;

  const idValid = ID_PATTERN.test(form.id) && !allAgentIds.has(form.id);
  const hostValid = form.mode === 'local' || (form.mode === 'remote' && form.host !== '');
  const runtimeValid = form.runtime !== '' && (
    form.runtime === 'claude-code' ? !!probe?.runtimes['claude-code'].ok : !!probe?.runtimes['codex'].ok
  );
  const tmuxValid = !!probe?.tmux.ok;
  const sshValid = form.mode === 'local' || !!probe?.ssh?.ok;
  const pairValid = form.role === 'dev' || (form.role === 'qa' && form.pairWith !== '');
  const canSubmit = !submitting && idValid && hostValid && pairValid && runtimeValid && tmuxValid && sshValid;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const trimmedAddDirs = form.addDirs
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      const body: AddAgentBody = {
        id: form.id,
        role: form.role,
        runtime: form.runtime as AgentRuntime,
        mode: form.mode,
        ...(form.mode === 'remote' ? { host: form.host } : {}),
        ...(form.workdir ? { workdir: form.workdir } : {}),
        yolo: form.yolo,
        ...(form.model.trim() ? { model: form.model.trim() } : {}),
        ...(trimmedAddDirs.length > 0 ? { addDirs: trimmedAddDirs } : {}),
        ...(form.role === 'qa' ? { pairWith: form.pairWith } : {}),
      };
      const result = await api.projects.addAgent(projectId, body);
      if (result.restartRequired) flagDirty();
      show({
        kind: 'success',
        title: `Agent ${result.agent.id} 已添加到 ${projectId}`,
      });
      onCreated();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const RuntimeStatus = ({ rt }: { rt: AgentRuntime }) => {
    const isRemoteNoHost = form.mode === 'remote' && !form.host;
    if (isRemoteNoHost) return <span className="ml-2 text-xs text-og-400">（请先选择 Host）</span>;
    if (probeLoading) return <span className="ml-2 text-xs text-og-400">…探测中</span>;
    if (!probe) return <span className="ml-2 text-xs text-og-400">?</span>;
    const status = probe.runtimes[rt];
    if (status.ok) return <span className="ml-2 text-xs text-probe-ok">✓ {status.path ?? ''}</span>;
    return <span className="ml-2 text-xs text-accent" title={status.message}>⨯ {status.message}</span>;
  };

  const TmuxStatus = () => {
    if (form.mode === 'remote' && !form.host) return null;
    if (probeLoading && !installingTmux) return <div className="text-xs text-og-400">tmux: …探测中</div>;
    if (!probe) return null;
    if (probe.tmux.ok) return <div className="text-xs text-probe-ok">tmux: ✓ {probe.tmux.path ?? ''}</div>;
    const sshReady = form.mode === 'local' || !!probe.ssh?.ok;
    return (
      <div className="space-y-1">
        <div className="text-xs text-accent">
          tmux: ⨯ {probe.tmux.message}
          {sshReady && (
            <button type="button" onClick={handleInstallTmux}
              className="ml-2 text-accent underline transition-colors hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={installingTmux || submitting}>
              {installingTmux ? '安装中…' : '一键安装'}
            </button>
          )}
        </div>
        {installingTmux && (
          <div className="text-xs text-og-500">正在安装 tmux，可能需要几分钟，请勿关闭窗口…</div>
        )}
        {!installingTmux && tmuxInstall && (
          <div className={`break-all text-xs ${tmuxInstall.ok ? 'text-probe-ok' : 'text-accent'}`}>
            {tmuxInstall.ok ? '✓ ' : '⨯ '}{tmuxInstall.message}
          </div>
        )}
      </div>
    );
  };

  const SshStatus = () => {
    if (form.mode !== 'remote' || !form.host || !probe?.ssh) return null;
    if (probe.ssh.ok) return <div className="text-xs text-probe-ok">SSH: ✓ {probe.ssh.message}</div>;
    return <div className="text-xs text-accent">SSH: ⨯ {probe.ssh.message}</div>;
  };

  return (
    <Modal
      open={open}
      onClose={handleDismiss}
      title={`添加 Agent 到 ${projectId}`}
      size="lg"
      footer={
        <>
          <button type="button" onClick={handleDismiss} disabled={submitting} className="btn-secondary">
            取消
          </button>
          <button type="submit" form="create-agent-form" disabled={!canSubmit} className="btn-primary">
            {submitting ? '添加中…' : '添加 Agent'}
          </button>
        </>
      }
    >
      <form id="create-agent-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <div className="rounded-md border border-accent/25 bg-accent-soft px-3 py-2 text-sm text-accent">
            {error}
          </div>
        )}

        <div>
          <label className={labelCls} htmlFor="agent-id">Agent ID</label>
          <input
            id="agent-id"
            type="text"
            value={form.id}
            onChange={e => setForm({ ...form, id: e.target.value })}
            className={inputCls}
            placeholder={`${projectId}-${form.role}`}
            disabled={submitting}
          />
          {form.id && !ID_PATTERN.test(form.id) && (
            <div className={fieldErrCls}>小写字母开头，只含 a-z 0-9 -，长度 2-32</div>
          )}
          {form.id && allAgentIds.has(form.id) && (
            <div className={fieldErrCls}>该 id 已被占用（全局唯一）</div>
          )}
        </div>

        <div>
          <span className={labelCls}>角色</span>
          <label className="mr-4 inline-flex items-center gap-2">
            <input type="radio" name="role" checked={form.role === 'dev'} className={radioCls}
              onChange={() => setForm({ ...form, role: 'dev', pairWith: '' })} disabled={submitting} />
            <span className="text-sm text-og-800">Dev agent</span>
          </label>
          <label className="inline-flex items-center gap-2" title={!canSelectQa ? '请先创建一个 Dev agent' : ''}>
            <input type="radio" name="role" checked={form.role === 'qa'} className={radioCls}
              onChange={() => setForm({ ...form, role: 'qa' })} disabled={submitting || !canSelectQa} />
            <span className={`text-sm ${!canSelectQa ? 'text-og-400' : 'text-og-800'}`}>QA agent</span>
          </label>
        </div>

        {form.role === 'qa' && (
          <div>
            <label className={labelCls} htmlFor="pair-with">配对 Dev agent</label>
            <select id="pair-with" value={form.pairWith}
              onChange={e => setForm({ ...form, pairWith: e.target.value })}
              className={inputCls} disabled={submitting}>
              <option value="">请选择</option>
              {unpairedDevs.map(d => (
                <option key={d.id} value={d.id}>{d.id}（{d.mode}）</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <span className={labelCls}>运行模式</span>
          <label className="mr-4 inline-flex items-center gap-2">
            <input type="radio" name="mode" checked={form.mode === 'local'} className={radioCls}
              onChange={() => setForm({ ...form, mode: 'local', host: '' })}
              disabled={submitting} />
            <span className="text-sm text-og-800">本机</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="mode" checked={form.mode === 'remote'} className={radioCls}
              onChange={() => setForm({ ...form, mode: 'remote' })} disabled={submitting} />
            <span className="text-sm text-og-800">远程 (SSH)</span>
          </label>
        </div>

        {form.mode === 'remote' && (
          <div>
            <label className={labelCls} htmlFor="host">Host</label>
            {hosts.length === 0 ? (
              <div className="rounded-md border border-og-100 bg-og-50/40 px-3 py-2 text-xs text-og-600">
                还没有配置 Host。请先在右上角菜单的「Host 管理」中添加。
              </div>
            ) : (
              <select id="host" value={form.host}
                onChange={e => setForm({ ...form, host: e.target.value })}
                className={inputCls} disabled={submitting}>
                <option value="">请选择 Host</option>
                {hosts.map(h => (
                  <option key={h.id} value={h.id}>{hostLabel(h)}</option>
                ))}
              </select>
            )}
            <div className={helpCls}>私钥/跳板机仍可在 ~/.ssh/config 配置；端口/密码在「Host 管理」里设置。</div>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-og-700">运行时</span>
            <button type="button" onClick={runProbe}
              className="text-xs text-accent transition-colors hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={submitting || probeLoading || (form.mode === 'remote' && !form.host)}>
              ↻ 重新探测
            </button>
          </div>
          <label className="flex items-center gap-2">
            <input type="radio" name="runtime" checked={form.runtime === 'claude-code'} className={radioCls}
              onChange={() => setForm({ ...form, runtime: 'claude-code' })}
              disabled={submitting || (probe ? !probe.runtimes['claude-code'].ok : false)} />
            <span className="text-sm text-og-800">Claude Code</span>
            <RuntimeStatus rt="claude-code" />
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="runtime" checked={form.runtime === 'codex'} className={radioCls}
              onChange={() => setForm({ ...form, runtime: 'codex' })}
              disabled={submitting || (probe ? !probe.runtimes['codex'].ok : false)} />
            <span className="text-sm text-og-800">Codex</span>
            <RuntimeStatus rt="codex" />
          </label>
          <div className="mt-2"><TmuxStatus /></div>
          <div><SshStatus /></div>
        </div>

        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced(v => !v)}
            aria-expanded={showAdvanced}
            aria-controls={showAdvanced ? 'advanced-options' : undefined}
            className="flex w-full items-center justify-between rounded-md px-1 py-1.5 text-left text-xs font-medium text-og-700 transition-colors hover:bg-og-50"
          >
            <span>高级选项</span>
            <span className="text-og-400">{showAdvanced ? '收起' : '展开'}</span>
          </button>
          {showAdvanced && (
            <div id="advanced-options" className="mt-3 space-y-3">
              <div>
                <label className={labelCls} htmlFor="workdir">Workdir（可选）</label>
                <input id="workdir" type="text" value={form.workdir}
                  onChange={e => setForm({ ...form, workdir: e.target.value })}
                  className={inputCls}
                  placeholder="留空时自动 clone 到 ~/.baxian/repos/<owner>/<repo>"
                  disabled={submitting} />
              </div>

              <div>
                <label className={labelCls} htmlFor="model">Model（可选）</label>
                <input id="model" type="text" value={form.model}
                  onChange={e => setForm({ ...form, model: e.target.value })}
                  className={inputCls}
                  placeholder={form.runtime === 'codex' ? '例: o3 / gpt-4o（留空走 default）' : '例: sonnet / opus / claude-sonnet-4-6（留空走 default）'}
                  disabled={submitting} />
                <div className={helpCls}>透传到 launch 命令的 --model 参数；留空跟随 CLI 默认。</div>
              </div>

              <div>
                <label className={labelCls} htmlFor="addDirs">Additional Dirs（可选）</label>
                <textarea id="addDirs" value={form.addDirs}
                  onChange={e => setForm({ ...form, addDirs: e.target.value })}
                  className={`${inputCls} font-mono text-xs`}
                  rows={3}
                  placeholder={'每行一个绝对路径，例:\n/Users/me/shared-libs\n/Users/me/extra-repo'}
                  disabled={submitting} />
                <div className={helpCls}>透传到 --add-dir。当前 YOLO 模式下不影响权限拦截，主要用于让 CLI 把额外目录纳入工作根。</div>
              </div>
            </div>
          )}
        </div>

        <div className="rounded-md border border-accent/25 bg-accent-soft/60 px-3 py-2.5">
          <label className="flex cursor-pointer items-start gap-2">
            <input type="checkbox" className="mt-1 h-3.5 w-3.5 accent-accent" checked={form.yolo}
              onChange={e => setForm({ ...form, yolo: e.target.checked })}
              disabled={submitting} />
            <div className="text-sm text-og-800">
              <div className="font-medium">YOLO 模式（推荐开启）</div>
              <div className="mt-1 text-xs text-accent">
                开启后 Claude Code 以 <code>--permission-mode bypassPermissions</code> 启动，
                Codex 以 <code>--dangerously-bypass-approvals-and-sandbox</code> 启动。
              </div>
            </div>
          </label>
        </div>
      </form>
    </Modal>
  );
}
