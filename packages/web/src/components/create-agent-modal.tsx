import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import type { AgentMode, AgentRuntime, AgentRole, ProjectConfig, AgentConfig, HostConfig } from '../shared/index.js';
import { AGENT_RUNTIME_LAUNCH_FLAG } from '../shared/index.js';
import { Modal } from './modal.tsx';
import { inputCls, labelCls, fieldErrCls, helpCls, radioCls } from './form-styles.ts';
import { api, type ProbeResponse, type AddAgentBody } from '../api.ts';
import { useToast } from './toast.tsx';
import { usePendingRestart } from '../hooks/use-pending-restart.tsx';
import { useT } from '../i18n/index.tsx';

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
  const t = useT();
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

  const devGroups: AgentConfig[][] = project?.agent.filter(group => group.some(a => a.role === 'dev')) ?? [];
  const eligibleDevs = (role: 'qa' | 'research'): AgentConfig[] => devGroups
    .filter(group => !group.some(a => a.role === role))
    .map(group => group.find(a => a.role === 'dev')!);
  const qaEligibleDevs = eligibleDevs('qa');
  const researchEligibleDevs = eligibleDevs('research');

  const canSelectQa = qaEligibleDevs.length > 0;
  const canSelectResearch = researchEligibleDevs.length > 0;

  const idValid = ID_PATTERN.test(form.id) && !allAgentIds.has(form.id);
  const hostValid = form.mode === 'local' || (form.mode === 'remote' && form.host !== '');
  const runtimeValid = form.runtime !== '' && !!probe?.runtimes[form.runtime]?.ok;
  const tmuxValid = !!probe?.tmux.ok;
  const sshValid = form.mode === 'local' || !!probe?.ssh?.ok;
  const pairValid = form.role === 'dev'
    || ((form.role === 'qa' || form.role === 'research') && form.pairWith !== '');
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
        ...(form.role === 'qa' || form.role === 'research' ? { pairWith: form.pairWith } : {}),
      };
      const result = await api.projects.addAgent(projectId, body);
      if (result.restartRequired) flagDirty();
      show({
        kind: 'success',
        title: t.createAgent.addedToastTitle(result.agent.id, projectId),
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
    if (isRemoteNoHost) return <span className="ml-2 text-xs text-og-400">{t.createAgent.selectHostFirstHint}</span>;
    if (probeLoading) return <span className="ml-2 text-xs text-og-400">{t.createAgent.probingLabel}</span>;
    if (!probe) return <span className="ml-2 text-xs text-og-400">?</span>;
    const status = probe.runtimes[rt];
    if (!status) return <span className="ml-2 text-xs text-og-400">?</span>;
    if (status.ok) return <span className="ml-2 text-xs text-probe-ok">✓ {status.path ?? ''}</span>;
    return <span className="ml-2 text-xs text-accent" title={status.message}>⨯ {status.message}</span>;
  };

  const TmuxStatus = () => {
    if (form.mode === 'remote' && !form.host) return null;
    if (probeLoading && !installingTmux) return <div className="text-xs text-og-400">{t.createAgent.tmuxProbingLabel}</div>;
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
              {installingTmux ? t.common.installing : t.common.oneClickInstall}
            </button>
          )}
        </div>
        {installingTmux && (
          <div className="text-xs text-og-500">{t.common.installingTmuxNotice}</div>
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
      title={t.createAgent.modalTitle(projectId)}
      size="lg"
      footer={
        <>
          <button type="button" onClick={handleDismiss} disabled={submitting} className="btn-secondary">
            {t.common.cancel}
          </button>
          <button type="submit" form="create-agent-form" disabled={!canSubmit} className="btn-primary">
            {submitting ? t.createAgent.submitting : t.createAgent.submitLabel}
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
            placeholder={t.createAgent.idPlaceholder(projectId, form.role)}
            disabled={submitting}
          />
          {form.id && !ID_PATTERN.test(form.id) && (
            <div className={fieldErrCls}>{t.common.idFormatError}</div>
          )}
          {form.id && allAgentIds.has(form.id) && (
            <div className={fieldErrCls}>{t.createAgent.idTakenGlobalError}</div>
          )}
        </div>

        <div>
          <span className={labelCls}>{t.createAgent.roleLabel}</span>
          <label className="mr-4 inline-flex items-center gap-2">
            <input type="radio" name="role" checked={form.role === 'dev'} className={radioCls}
              onChange={() => setForm({ ...form, role: 'dev', pairWith: '' })} disabled={submitting} />
            <span className="text-sm text-og-800">Dev agent</span>
          </label>
          <label className="mr-4 inline-flex items-center gap-2" title={!canSelectQa ? t.createAgent.createDevFirstHint : ''}>
            <input type="radio" name="role" checked={form.role === 'qa'} className={radioCls}
              onChange={() => setForm({ ...form, role: 'qa', pairWith: '' })} disabled={submitting || !canSelectQa} />
            <span className={`text-sm ${!canSelectQa ? 'text-og-400' : 'text-og-800'}`}>QA agent</span>
          </label>
          <label className="inline-flex items-center gap-2" title={!canSelectResearch ? t.createAgent.createDevFirstHint : ''}>
            <input type="radio" name="role" checked={form.role === 'research'} className={radioCls}
              onChange={() => setForm({ ...form, role: 'research', pairWith: '' })} disabled={submitting || !canSelectResearch} />
            <span className={`text-sm ${!canSelectResearch ? 'text-og-400' : 'text-og-800'}`}>
              {t.createAgent.roleResearch}
            </span>
          </label>
        </div>

        {(form.role === 'qa' || form.role === 'research') && (
          <div>
            <label className={labelCls} htmlFor="pair-with">{t.createAgent.pairWithLabel}</label>
            <select id="pair-with" value={form.pairWith}
              onChange={e => setForm({ ...form, pairWith: e.target.value })}
              className={inputCls} disabled={submitting}>
              <option value="">{t.createAgent.pairWithPlaceholder}</option>
              {(form.role === 'qa' ? qaEligibleDevs : researchEligibleDevs).map(d => (
                <option key={d.id} value={d.id}>{t.createAgent.pairOptionLabel(d.id, d.mode)}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <span className={labelCls}>{t.createAgent.modeLabel}</span>
          <label className="mr-4 inline-flex items-center gap-2">
            <input type="radio" name="mode" checked={form.mode === 'local'} className={radioCls}
              onChange={() => setForm({ ...form, mode: 'local', host: '' })}
              disabled={submitting} />
            <span className="text-sm text-og-800">{t.createAgent.localModeLabel}</span>
          </label>
          <label className="inline-flex items-center gap-2">
            <input type="radio" name="mode" checked={form.mode === 'remote'} className={radioCls}
              onChange={() => setForm({ ...form, mode: 'remote' })} disabled={submitting} />
            <span className="text-sm text-og-800">{t.createAgent.remoteModeLabel}</span>
          </label>
        </div>

        {form.mode === 'remote' && (
          <div>
            <label className={labelCls} htmlFor="host">Host</label>
            {hosts.length === 0 ? (
              <div className="rounded-md border border-og-100 bg-og-50/40 px-3 py-2 text-xs text-og-600">
                {t.createAgent.noHostsHint}
              </div>
            ) : (
              <select id="host" value={form.host}
                onChange={e => setForm({ ...form, host: e.target.value })}
                className={inputCls} disabled={submitting}>
                <option value="">{t.createAgent.selectHostPlaceholder}</option>
                {hosts.map(h => (
                  <option key={h.id} value={h.id}>{hostLabel(h)}</option>
                ))}
              </select>
            )}
            <div className={helpCls}>{t.createAgent.sshConfigHint}</div>
          </div>
        )}

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-xs font-medium text-og-700">{t.createAgent.runtimeLabel}</span>
            <button type="button" onClick={runProbe}
              className="text-xs text-accent transition-colors hover:text-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
              disabled={submitting || probeLoading || (form.mode === 'remote' && !form.host)}>
              {t.createAgent.reprobeButton}
            </button>
          </div>
          <label className="flex items-center gap-2">
            <input type="radio" name="runtime" checked={form.runtime === 'claude-code'} className={radioCls}
              onChange={() => setForm({ ...form, runtime: 'claude-code' })}
              disabled={submitting || (probe ? !probe.runtimes['claude-code']?.ok : false)} />
            <span className="text-sm text-og-800">Claude Code</span>
            <RuntimeStatus rt="claude-code" />
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="runtime" checked={form.runtime === 'codex'} className={radioCls}
              onChange={() => setForm({ ...form, runtime: 'codex' })}
              disabled={submitting || (probe ? !probe.runtimes['codex']?.ok : false)} />
            <span className="text-sm text-og-800">Codex</span>
            <RuntimeStatus rt="codex" />
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="runtime" checked={form.runtime === 'opencode'} className={radioCls}
              onChange={() => setForm({ ...form, runtime: 'opencode' })}
              disabled={submitting || (probe ? !probe.runtimes['opencode']?.ok : false)} />
            <span className="text-sm text-og-800">OpenCode</span>
            <RuntimeStatus rt="opencode" />
          </label>
          <label className="mt-1 flex items-center gap-2">
            <input type="radio" name="runtime" checked={form.runtime === 'qodercli'} className={radioCls}
              onChange={() => setForm({ ...form, runtime: 'qodercli' })}
              disabled={submitting || (probe ? !probe.runtimes['qodercli']?.ok : false)} />
            <span className="text-sm text-og-800">Qoder CLI</span>
            <RuntimeStatus rt="qodercli" />
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
            <span>{t.createAgent.advancedOptionsLabel}</span>
            <span className="text-og-400">{showAdvanced ? t.createAgent.collapseLabel : t.createAgent.expandLabel}</span>
          </button>
          {showAdvanced && (
            <div id="advanced-options" className="mt-3 space-y-3">
              <div>
                <label className={labelCls} htmlFor="workdir">{t.createAgent.workdirLabel}</label>
                <input id="workdir" type="text" value={form.workdir}
                  onChange={e => setForm({ ...form, workdir: e.target.value })}
                  className={inputCls}
                  placeholder={t.createAgent.workdirPlaceholder}
                  disabled={submitting} />
                <div className={helpCls}>{t.createAgent.workdirHint}</div>
              </div>

              <div>
                <label className={labelCls} htmlFor="model">{t.createAgent.modelLabel}</label>
                <input id="model" type="text" value={form.model}
                  onChange={e => setForm({ ...form, model: e.target.value })}
                  className={inputCls}
                  placeholder={form.runtime === 'codex' ? t.createAgent.modelPlaceholderCodex : t.createAgent.modelPlaceholderOther}
                  disabled={submitting} />
                <div className={helpCls}>{t.createAgent.modelHint}</div>
              </div>

              <div>
                <label className={labelCls} htmlFor="addDirs">{t.createAgent.addDirsLabel}</label>
                <textarea id="addDirs" value={form.addDirs}
                  onChange={e => setForm({ ...form, addDirs: e.target.value })}
                  className={`${inputCls} font-mono text-xs`}
                  rows={3}
                  placeholder={t.createAgent.addDirsPlaceholder}
                  disabled={submitting} />
                <div className={helpCls}>{t.createAgent.addDirsHint}</div>
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
              <div className="font-medium">{t.createAgent.yoloTitle}</div>
              <div className="mt-1 text-xs text-accent">
                {t.createAgent.yoloBodyLead}<code>{AGENT_RUNTIME_LAUNCH_FLAG[form.runtime || 'claude-code']}</code>{t.createAgent.yoloBodyTrail}
              </div>
            </div>
          </label>
        </div>
      </form>
    </Modal>
  );
}
