import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MergeStrategy } from '../shared/index.js';
import { Modal } from './modal.tsx';
import { api } from '../api.ts';
import { useToast } from './toast.tsx';
import { usePendingRestart } from '../hooks/use-pending-restart.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
// Mirrors server-side parseGitRemote (shared/git-url.ts): any-host https/ssh/scp git URL,
// plus legacy bare "owner/repo". The server validator is authoritative; this is a fast pre-check.
const REPO_URL_PATTERNS = [
  /^https?:\/\/[^/\s]+\/[^\s]+$/,
  /^ssh:\/\/[^/\s]+\/[^\s]+$/,
  /^[^@/\s]+@[^:/\s]+:[^\s]+$/,
  /^[^/\s:@]+\/[^/\s]+$/,
];

const inputCls =
  'w-full rounded-md border border-og-100 bg-surface px-2.5 py-1.5 text-[13px] text-og-800 placeholder:text-og-400 focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-soft disabled:cursor-not-allowed disabled:opacity-50';
const labelCls = 'mb-1.5 block text-[12px] font-medium text-og-700';
const fieldErrCls = 'mt-1 text-[12px] text-danger';

export function CreateProjectModal({ open, onClose, onCreated }: Props) {
  const [id, setId] = useState('');
  const [repo, setRepo] = useState('');
  const [merge, setMerge] = useState<MergeStrategy>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ id?: string; repo?: string }>({});
  const [existingIds, setExistingIds] = useState<Set<string>>(new Set());
  const sessionRef = useRef(0);
  const { show } = useToast();
  const { flagDirty } = usePendingRestart();

  useEffect(() => {
    if (!open) return;
    sessionRef.current += 1;
    const session = sessionRef.current;
    setId('');
    setRepo('');
    setMerge(null);
    setError(null);
    setFieldErrors({});
    setExistingIds(new Set());
    api.config
      .get()
      .then(cfg => {
        if (session !== sessionRef.current) return;
        setExistingIds(new Set(cfg.project.map(p => p.id)));
      })
      .catch(() => {});
  }, [open]);

  const handleDismiss = () => {
    if (submitting) return;
    onClose();
  };

  const validate = (): boolean => {
    const errs: { id?: string; repo?: string } = {};
    if (!id) errs.id = '必填';
    else if (!ID_PATTERN.test(id)) errs.id = '小写字母开头，只含 a-z 0-9 -，长度 2-32';
    else if (existingIds.has(id)) errs.id = '该 id 已被占用';

    if (!repo) errs.repo = '必填';
    else if (!REPO_URL_PATTERNS.some(re => re.test(repo.trim()))) {
      errs.repo = '需为 git URL（https / ssh / scp，如 https://gitlab.example.com/group/proj.git）或 owner/repo';
    }

    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  };

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!validate()) return;

    setSubmitting(true);
    setError(null);
    try {
      const result = await api.projects.create({ id, repo: repo.trim(), merge });
      if (result.restartRequired) flagDirty();
      show({
        kind: 'success',
        title: `项目 ${result.project.id} 已创建`,
      });
      onCreated(result.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={handleDismiss}
      title="新建项目"
      size="md"
      footer={
        <>
          <button type="button" onClick={handleDismiss} disabled={submitting} className="btn-secondary">
            取消
          </button>
          <button type="submit" form="create-project-form" disabled={submitting} className="btn-primary">
            {submitting ? '创建中…' : '创建'}
          </button>
        </>
      }
    >
      <form id="create-project-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <div className="rounded-md border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        )}

        <div>
          <label className={labelCls} htmlFor="proj-id">项目 ID</label>
          <input
            id="proj-id"
            type="text"
            value={id}
            onChange={e => setId(e.target.value)}
            className={inputCls}
            placeholder="kongkong"
            disabled={submitting}
          />
          {fieldErrors.id && <div className={fieldErrCls}>{fieldErrors.id}</div>}
        </div>

        <div>
          <label className={labelCls} htmlFor="proj-repo">Git 仓库地址</label>
          <input
            id="proj-repo"
            type="text"
            value={repo}
            onChange={e => setRepo(e.target.value)}
            className={inputCls}
            placeholder="https://github.com/baxian-ai/baxian.git"
            disabled={submitting}
          />
          {fieldErrors.repo && <div className={fieldErrCls}>{fieldErrors.repo}</div>}
        </div>

        <div>
          <span className={labelCls}>合并策略</span>
          <label className="mb-1 flex items-center gap-2">
            <input
              type="radio"
              name="merge"
              checked={merge === null}
              onChange={() => setMerge(null)}
              disabled={submitting}
              className="h-3.5 w-3.5 accent-[#1348dc]"
            />
            <span className="text-[13px] text-og-800">人类合并（默认）</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="merge"
              checked={merge === 'auto'}
              onChange={() => setMerge('auto')}
              disabled={submitting}
              className="h-3.5 w-3.5 accent-[#1348dc]"
            />
            <span className="text-[13px] text-og-800">QA Approve 后自动合并</span>
          </label>
        </div>
      </form>
    </Modal>
  );
}
