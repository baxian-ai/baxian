import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { MergeStrategy, SpecApprovalStrategy } from '../shared/index.js';
import { Modal } from './modal.tsx';
import { inputCls, labelCls, fieldErrCls } from './form-styles.ts';
import { api } from '../api.ts';
import { useToast } from './toast.tsx';
import { usePendingRestart } from '../hooks/use-pending-restart.tsx';
import { useT } from '../i18n/index.tsx';

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (projectId: string) => void;
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const HTTP_REPO_URL_PATTERN = /^https?:\/\/[^/\s]+\/[^\s]+$/;
const BARE_REPO_SLUG_PATTERN = /^[^/\s:@]+\/[^/\s]+$/;
const REPO_URL_PATTERNS = [
  HTTP_REPO_URL_PATTERN,
  /^ssh:\/\/git@github\.com\/[^\s]+$/,
  /^git@github\.com:[^\s]+$/,
  BARE_REPO_SLUG_PATTERN,
];

function isBareSlug(repo: string): boolean {
  return BARE_REPO_SLUG_PATTERN.test(repo.trim());
}

function isGitHubRepo(repo: string): boolean {
  const value = repo.trim();
  return isBareSlug(value)
    || /^https?:\/\/github\.com\//.test(value)
    || /^ssh:\/\/git@github\.com\//.test(value)
    || /^git@github\.com:/.test(value);
}

export function CreateProjectModal({ open, onClose, onCreated }: Props) {
  const t = useT();
  const [id, setId] = useState('');
  const [repo, setRepo] = useState('');
  const [merge, setMerge] = useState<MergeStrategy>(null);
  const [specApproval, setSpecApproval] = useState<SpecApprovalStrategy>('human');
  const [gitCliTool, setGitCliTool] = useState('');
  const [gitCliNotes, setGitCliNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<{ id?: string; repo?: string; gitCliTool?: string }>({});
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
    setSpecApproval('human');
    setGitCliTool('');
    setGitCliNotes('');
    setError(null);
    setFieldErrors({});
    setExistingIds(new Set());
    api.config
      .get()
      .then(cfg => {
        if (session !== sessionRef.current) return;
        setExistingIds(new Set(cfg.project.map(p => p.id)));
      })
      .catch(err => {
        if (session !== sessionRef.current) return;
        setError(t.common.loadFailed(err instanceof Error ? err.message : String(err)));
      });
  }, [open]);

  const handleDismiss = () => {
    if (submitting) return;
    onClose();
  };

  const showGitCli = repo.trim() !== '' && !isBareSlug(repo);

  const validate = (): boolean => {
    const errs: { id?: string; repo?: string; gitCliTool?: string } = {};
    const normalizedRepo = repo.trim();
    if (!id) errs.id = t.createProject.required;
    else if (!ID_PATTERN.test(id)) errs.id = t.common.idFormatError;
    else if (existingIds.has(id)) errs.id = t.createProject.idTakenError;

    const repoValid = REPO_URL_PATTERNS.some(re => re.test(normalizedRepo));
    if (!repo) errs.repo = t.createProject.required;
    else if (!repoValid) {
      errs.repo = t.createProject.repoFormatError;
    }
    if (repoValid && !isGitHubRepo(normalizedRepo) && gitCliTool.trim() === '') {
      errs.gitCliTool = t.createProject.gitCliToolRequired;
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
      const result = await api.projects.create({
        id,
        repo: repo.trim(),
        merge,
        ...(specApproval ? { specApproval } : {}),
        ...(showGitCli && gitCliTool.trim()
          ? { gitCli: { tool: gitCliTool.trim(), ...(gitCliNotes.trim() ? { notes: gitCliNotes.trim() } : {}) } }
          : {}),
      });
      if (result.restartRequired) flagDirty();
      show({
        kind: 'success',
        title: t.createProject.createdToastTitle(result.project.id),
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
      title={t.createProject.title}
      size="md"
      footer={
        <>
          <button type="button" onClick={handleDismiss} disabled={submitting} className="btn-secondary">
            {t.common.cancel}
          </button>
          <button type="submit" form="create-project-form" disabled={submitting} className="btn-primary">
            {submitting ? t.common.creating : t.common.create}
          </button>
        </>
      }
    >
      <form id="create-project-form" onSubmit={handleSubmit} className="space-y-3">
        {error && (
          <div className="whitespace-pre-line rounded-md border border-accent/25 bg-accent-soft px-3 py-2 text-sm text-accent">
            {error}
          </div>
        )}

        <div>
          <label className={labelCls} htmlFor="proj-id">{t.createProject.idLabel}</label>
          <input
            id="proj-id"
            type="text"
            value={id}
            onChange={e => setId(e.target.value)}
            className={inputCls}
            placeholder="baxian"
            disabled={submitting}
          />
          {fieldErrors.id && <div className={fieldErrCls}>{fieldErrors.id}</div>}
        </div>

        <div>
          <label className={labelCls} htmlFor="proj-repo">{t.createProject.repoLabel}</label>
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
          <span className={labelCls}>{t.createProject.mergeStrategyLabel}</span>
          <label className="mb-1 flex items-center gap-2">
            <input
              type="radio"
              name="merge"
              checked={merge === null}
              onChange={() => setMerge(null)}
              disabled={submitting}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span className="text-sm text-og-800">{t.createProject.mergeHumanLabel}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="merge"
              checked={merge === 'auto'}
              onChange={() => setMerge('auto')}
              disabled={submitting}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span className="text-sm text-og-800">{t.createProject.mergeAutoLabel}</span>
          </label>
        </div>

        <div>
          <span className={labelCls}>{t.createProject.specApprovalLabel}</span>
          <label className="mb-1 flex items-center gap-2">
            <input
              type="radio"
              name="spec-approval"
              checked={specApproval === 'human'}
              onChange={() => setSpecApproval('human')}
              disabled={submitting}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span className="text-sm text-og-800">{t.createProject.specApprovalHumanLabel}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="spec-approval"
              checked={specApproval === null}
              onChange={() => setSpecApproval(null)}
              disabled={submitting}
              className="h-3.5 w-3.5 accent-accent"
            />
            <span className="text-sm text-og-800">{t.createProject.specApprovalAutoLabel}</span>
          </label>
        </div>

        {showGitCli && (
          <div>
            <label className="mb-1 block">
              <span className={labelCls}>{t.createProject.gitCliToolLabel}</span>
              <input
                value={gitCliTool}
                onChange={e => setGitCliTool(e.target.value)}
                placeholder={t.createProject.gitCliToolPlaceholder}
                disabled={submitting}
                className={inputCls}
              />
              {fieldErrors.gitCliTool && <div className={fieldErrCls}>{fieldErrors.gitCliTool}</div>}
            </label>
            <label className="block">
              <span className={labelCls}>{t.createProject.gitCliNotesLabel}</span>
              <input
                value={gitCliNotes}
                onChange={e => setGitCliNotes(e.target.value)}
                disabled={submitting}
                className={inputCls}
              />
            </label>
          </div>
        )}
      </form>
    </Modal>
  );
}
