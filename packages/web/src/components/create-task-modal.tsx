import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AgentSnapshot, ProjectConfig, TaskState } from '../shared/index.js';
import { IMAGE_UPLOAD_MAX_BYTES, TASK_IMAGE_MAX_COUNT } from '../shared/index.js';
import { Modal } from './modal.tsx';
import { inputCls, labelCls } from './form-styles.ts';
import { api, fileToBase64 } from '../api.ts';
import { useToast } from './toast.tsx';

interface CreateProps {
  mode?: 'create';
  open: boolean;
  onClose: () => void;
  projectId?: string;
  onCreated?: (task: TaskState) => void;
}

interface EditProps {
  mode: 'edit';
  open: boolean;
  onClose: () => void;
  task: TaskState;
  onUpdated?: (task: TaskState) => void;
}

type Props = CreateProps | EditProps;

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 16000;
const DRAFT_KEY_PREFIX = 'baxian.draft.createTask:';

interface CreateTaskDraft {
  title: string;
  description: string;
  projectId: string;
  preferredAgentId: string;
  updatedAt?: number;
}

function draftKey(projectIdProp: string | undefined): string {
  return `${DRAFT_KEY_PREFIX}${projectIdProp ?? '*'}`;
}

function loadDraft(key: string): CreateTaskDraft | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const p = parsed as Record<string, unknown>;
    const title = typeof p.title === 'string' ? p.title : '';
    const description = typeof p.description === 'string' ? p.description : '';
    const projectId = typeof p.projectId === 'string' ? p.projectId : '';
    const preferredAgentId = typeof p.preferredAgentId === 'string' ? p.preferredAgentId : '';
    const updatedAt = typeof p.updatedAt === 'number' ? p.updatedAt : undefined;
    if (!title.trim() && !description.trim()) return null;
    return { title, description, projectId, preferredAgentId, updatedAt };
  } catch {
    return null;
  }
}

function saveDraft(key: string, draft: CreateTaskDraft): void {
  const empty = !draft.title.trim() && !draft.description.trim();
  try {
    if (empty) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ ...draft, updatedAt: Date.now() }));
  } catch {
  }
}

function clearDraft(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
  }
}

function loadDraftForContext(projectIdProp: string | undefined): CreateTaskDraft | null {
  const ownKey = draftKey(projectIdProp);
  const own = loadDraft(ownKey);
  if (!projectIdProp) return own;
  const globalKey = draftKey(undefined);
  const global = loadDraft(globalKey);
  if (!global || global.projectId !== projectIdProp) return own;
  const useGlobal = !own || (global.updatedAt ?? 0) > (own.updatedAt ?? 0);
  if (useGlobal) {
    try {
      localStorage.setItem(ownKey, JSON.stringify(global));
    } catch {
      return global;
    }
  }
  try { localStorage.removeItem(globalKey); } catch { }
  return useGlobal ? global : own;
}

const counterCls = 'mt-1 text-right text-xs text-og-400';
const MAX_IMAGE_MIB = Math.floor(IMAGE_UPLOAD_MAX_BYTES / 1024 / 1024);

export function CreateTaskModal(props: Props) {
  const isEdit = props.mode === 'edit';
  const { show } = useToast();

  const projectIdProp = isEdit ? props.task.projectId : props.projectId;
  const initialTitle = isEdit ? props.task.title : '';
  const initialDescription = isEdit ? props.task.description : '';
  const initialPreferred = isEdit ? props.task.preferredAgentId : '';

  const [projects, setProjects] = useState<ProjectConfig[]>([]);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(projectIdProp ?? '');
  const [preferredAgentId, setPreferredAgentId] = useState<string>(initialPreferred);
  const [title, setTitle] = useState(initialTitle);
  const [description, setDescription] = useState(initialDescription);
  const [images, setImages] = useState<File[]>([]);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draftRestored, setDraftRestored] = useState(false);
  const sessionRef = useRef(0);
  const hydrationSessionRef = useRef(0);
  const lastSavedSessionRef = useRef(0);
  const devDefaultSettledRef = useRef<Set<string>>(new Set());

  const draftKeyValue = isEdit ? null : draftKey(projectIdProp);

  useEffect(() => {
    if (!props.open) return;
    sessionRef.current += 1;
    hydrationSessionRef.current += 1;
    const session = sessionRef.current;
    setProjects([]);
    setAgents([]);
    devDefaultSettledRef.current = new Set();

    const draft = draftKeyValue ? loadDraftForContext(projectIdProp) : null;
    if (draft) devDefaultSettledRef.current.add(draft.projectId);
    setSelectedProjectId(projectIdProp ?? draft?.projectId ?? '');
    setPreferredAgentId(draft?.preferredAgentId || initialPreferred);
    setTitle(draft?.title || initialTitle);
    setDescription(draft?.description || initialDescription);
    setDraftRestored(draft !== null);

    setError(null);
    setSubmitting(false);
    setImages([]);

    Promise.all([api.projects.list(), api.agents.list()])
      .then(([p, a]) => {
        if (session !== sessionRef.current) return;
        setProjects(p);
        setAgents(a);
      })
      .catch(err => {
        if (session !== sessionRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      });
  }, [props.open, projectIdProp, initialTitle, initialDescription, initialPreferred, draftKeyValue]);

  useEffect(() => {
    if (!props.open || !draftKeyValue) return;
    if (lastSavedSessionRef.current !== hydrationSessionRef.current) {
      lastSavedSessionRef.current = hydrationSessionRef.current;
      return;
    }
    saveDraft(draftKeyValue, {
      title,
      description,
      projectId: selectedProjectId,
      preferredAgentId,
    });
  }, [props.open, draftKeyValue, title, description, selectedProjectId, preferredAgentId]);

  const project = useMemo(
    () => projects.find(p => p.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const projectDevs = useMemo(
    () => (project ? project.agent.flat().filter(a => a.role === 'dev') : []),
    [project],
  );

  const runtimeIds = useMemo(() => new Set(agents.map(a => a.id)), [agents]);

  const visibleDevs = useMemo(
    () => projectDevs.filter(a => runtimeIds.has(a.id)),
    [projectDevs, runtimeIds],
  );

  const pendingRestartDevs = useMemo(
    () => projectDevs.filter(a => !runtimeIds.has(a.id)),
    [projectDevs, runtimeIds],
  );

  useEffect(() => {
    if (isEdit) return;
    if (project === null) return;
    if (preferredAgentId !== '' && !visibleDevs.find(d => d.id === preferredAgentId)) {
      setPreferredAgentId('');
    }
  }, [project, visibleDevs, preferredAgentId, isEdit]);

  useEffect(() => {
    if (isEdit) return;
    if (!project) return;
    if (visibleDevs.length === 0) return;
    if (devDefaultSettledRef.current.has(project.id)) return;
    devDefaultSettledRef.current.add(project.id);
    setPreferredAgentId(prev => (prev === '' ? visibleDevs[0].id : prev));
  }, [isEdit, project, visibleDevs]);

  const editPreferredVisible = !isEdit || visibleDevs.find(d => d.id === preferredAgentId);
  const editPreferredPending = isEdit && !editPreferredVisible && !!preferredAgentId;
  const editPreferredInPendingRestart = editPreferredPending
    && pendingRestartDevs.some(d => d.id === preferredAgentId);

  const noDevHint = (() => {
    if (editPreferredInPendingRestart) {
      return `当前 Dev agent "${preferredAgentId}" 在 baxian.json 中存在但 runtime 未加载，可能是手动编辑过配置文件；重启 server 可拉起`;
    }
    if (editPreferredPending) {
      return `当前 Dev agent "${preferredAgentId}" 不在 runtime（可能已从 project 配置移除）；保存可能失败，请确认或选择新 Dev agent`;
    }
    if (!selectedProjectId) return null;
    if (visibleDevs.length > 0) return null;
    if (pendingRestartDevs.length > 0) return 'baxian.json 里有 Dev agent 但 runtime 未加载（可能是手动编辑过配置）；重启 server 后生效';
    return null;
  })();

  const titleTrimmed = title.trim();
  const descriptionTrimmed = description.trim();
  const formReady =
    !!selectedProjectId &&
    titleTrimmed.length > 0;
  const canSubmit = formReady && !submitting;

  const handleDismiss = () => {
    if (submitting) return;
    props.onClose();
  };

  const handleDiscardDraft = () => {
    if (!draftKeyValue) return;
    clearDraft(draftKeyValue);
    setSelectedProjectId(projectIdProp ?? '');
    setPreferredAgentId(initialPreferred);
    setTitle(initialTitle);
    setDescription(initialDescription);
    setError(null);
    setDraftRestored(false);
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      if (props.mode === 'edit') {
        const updated = await api.tasks.update(props.task.id, {
          title: titleTrimmed,
          description: descriptionTrimmed,
          preferredAgentId,
        });
        show({ kind: 'success', title: '任务已更新' });
        props.onUpdated?.(updated);
        props.onClose();
      } else {
        const imagePayload = images.length
          ? await Promise.all(
              images.map(async (f) => ({ dataBase64: await fileToBase64(f), filename: f.name })),
            )
          : undefined;
        const task = await api.tasks.create({
          projectId: selectedProjectId,
          title: titleTrimmed,
          description: descriptionTrimmed,
          preferredAgentId,
          ...(imagePayload ? { images: imagePayload } : {}),
        });
        if (draftKeyValue) clearDraft(draftKeyValue);
        show({ kind: 'success', title: '任务已创建' });
        props.onCreated?.(task);
        props.onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleAddImages = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (picked.length === 0) return;
    const sized = picked.filter((f) => {
      if (f.size > IMAGE_UPLOAD_MAX_BYTES) {
        show({ kind: 'error', title: '图片过大', body: `${f.name} 超过 ${MAX_IMAGE_MIB} MiB` });
        return false;
      }
      return true;
    });
    setImages((prev) => {
      if (prev.length + sized.length > TASK_IMAGE_MAX_COUNT) {
        show({ kind: 'warn', title: `最多 ${TASK_IMAGE_MAX_COUNT} 张图片` });
      }
      return [...prev, ...sized].slice(0, TASK_IMAGE_MAX_COUNT);
    });
  };

  const removeImage = (idx: number) => setImages((prev) => prev.filter((_, i) => i !== idx));

  const modalTitle = isEdit ? '编辑任务' : '新建任务';
  const submitLabel = isEdit
    ? (submitting ? '保存中…' : '保存')
    : (submitting ? '创建中…' : '创建');
  const showProjectSelect = !isEdit && !projectIdProp;

  return (
    <Modal
      open={props.open}
      onClose={handleDismiss}
      title={modalTitle}
      size="md"
      dismissOnBackdrop={false}
      footer={
        <>
          <button type="button" onClick={handleDismiss} disabled={submitting} className="btn-secondary">
            取消
          </button>
          <button type="submit" form="create-task-form" disabled={!canSubmit} className="btn-primary">
            {submitLabel}
          </button>
        </>
      }
    >
      <form id="create-task-form" onSubmit={handleSubmit} className="space-y-3">
        {!isEdit && draftRestored && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-accent-soft bg-accent-soft/30 px-3 py-2 text-xs text-accent">
            <span>已恢复上次未提交的草稿</span>
            <button
              type="button"
              onClick={handleDiscardDraft}
              className="shrink-0 underline hover:text-accent-hover"
            >
              丢弃
            </button>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-accent/25 bg-accent-soft px-3 py-2 text-sm text-accent">
            {error}
          </div>
        )}

        {showProjectSelect && (
          <div>
            <label className={labelCls} htmlFor="task-project">Project</label>
            <select
              id="task-project"
              value={selectedProjectId}
              onChange={e => setSelectedProjectId(e.target.value)}
              className={inputCls}
              disabled={submitting}
              required
            >
              <option value="" disabled>选择项目</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.id}</option>
              ))}
            </select>
          </div>
        )}

        <div>
          <label className={labelCls} htmlFor="task-dev">Dev agent</label>
          <select
            id="task-dev"
            value={preferredAgentId}
            onChange={e => setPreferredAgentId(e.target.value)}
            className={inputCls}
            disabled={submitting}
          >
            <option value="">暂不指定</option>
            {editPreferredPending && (
              <option value={preferredAgentId}>
                {preferredAgentId} {editPreferredInPendingRestart ? '(待重启)' : '(不在 runtime)'}
              </option>
            )}
            {visibleDevs.map(d => (
              <option key={d.id} value={d.id}>{d.id}</option>
            ))}
          </select>
          {noDevHint && <div className="mt-1 text-xs text-accent">{noDevHint}</div>}
        </div>

        <div>
          <label className={labelCls} htmlFor="task-title">Title</label>
          <input
            id="task-title"
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            maxLength={TITLE_MAX}
            className={inputCls}
            placeholder="一句话描述要做什么"
            disabled={submitting}
            required
          />
          <div className={counterCls}>{title.length} / {TITLE_MAX}</div>
        </div>

        <div>
          <label className={labelCls} htmlFor="task-description">Description（可选）</label>
          <textarea
            id="task-description"
            value={description}
            onChange={e => setDescription(e.target.value)}
            maxLength={DESCRIPTION_MAX}
            rows={8}
            className={`${inputCls} font-mono text-xs`}
            placeholder="详细描述任务，支持 markdown；简单任务可不填"
            disabled={submitting}
          />
          <div className={counterCls}>{description.length} / {DESCRIPTION_MAX}</div>
        </div>

        {!isEdit && (
          <div>
            <label className={labelCls}>图片（可选）</label>
            <button
              type="button"
              onClick={() => imageInputRef.current?.click()}
              disabled={submitting || images.length >= TASK_IMAGE_MAX_COUNT}
              className="btn-secondary"
            >
              添加图片
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleAddImages}
            />
            {images.length > 0 && (
              <ul className="mt-2 space-y-1">
                {images.map((f, i) => (
                  <li
                    key={`${f.name}-${i}`}
                    className="flex items-center justify-between rounded-md border border-og-100 bg-surface px-2.5 py-1.5"
                  >
                    <span title={f.name} className="truncate text-xs text-og-700">{f.name}</span>
                    <button
                      type="button"
                      aria-label={`移除图片 ${f.name}`}
                      onClick={() => removeImage(i)}
                      disabled={submitting}
                      className="ml-2 shrink-0 text-og-400 transition-colors"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
