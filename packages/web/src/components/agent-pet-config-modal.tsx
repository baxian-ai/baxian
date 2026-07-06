import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import { api, ApiError } from '../api.ts';
import { Modal } from './modal.tsx';
import { useToast } from './toast.tsx';
import { useConfirm } from './confirm-dialog.tsx';
import { usePets } from '../hooks/use-pets.ts';
import { AgentPet, PET_DISPLAY_HEIGHT, PET_DISPLAY_WIDTH } from './agent-pet.tsx';
import { getMessages, useT } from '../i18n/index.tsx';

export class PetPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PetPackageError';
  }
}

const baseName = (name: string): string => name.split('/').pop() ?? name;

function readFileText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}

export async function parsePetPackage(files: File[]): Promise<{ manifest: unknown; spritesheet: File }> {
  const t = getMessages();
  const petJsonFile = files.find(
    (f) => baseName(f.name) === 'pet.json' || baseName(f.webkitRelativePath || '') === 'pet.json',
  );
  if (!petJsonFile) throw new PetPackageError(t.pet.missingManifest);
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFileText(petJsonFile));
  } catch {
    throw new PetPackageError(t.pet.manifestParseFailed);
  }
  const spritePath =
    manifest && typeof manifest === 'object' && typeof (manifest as { spritesheetPath?: unknown }).spritesheetPath === 'string'
      ? ((manifest as { spritesheetPath: string }).spritesheetPath)
      : '';
  const spriteBase = spritePath ? baseName(spritePath) : '';
  const spritesheet =
    (spriteBase ? files.find((f) => baseName(f.name) === spriteBase) : undefined) ??
    files.find((f) => /\.(png|webp)$/i.test(f.name));
  if (!spritesheet) throw new PetPackageError(t.pet.missingSpritesheet);
  return { manifest, spritesheet };
}

function LazyVisible({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (visible || typeof IntersectionObserver === 'undefined') return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [visible]);
  return <span ref={ref} className="inline-block shrink-0" style={style}>{visible ? children : null}</span>;
}

export interface AgentPetConfigModalProps {
  agentId: string;
  currentPetId: string | null;
  onClose: () => void;
}

export function AgentPetConfigModal({ agentId, currentPetId, onClose }: AgentPetConfigModalProps) {
  const t = useT();
  const { show } = useToast();
  const confirmDialog = useConfirm();
  const { pets, loading, refresh } = usePets();
  const [enabled, setEnabled] = useState(!!currentPetId);
  const [assignedPetId, setAssignedPetId] = useState<string | null>(currentPetId);
  const [busy, setBusy] = useState(false);
  const dirInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setAssignedPetId(currentPetId);
  }, [currentPetId]);

  useEffect(() => {
    const el = dirInputRef.current;
    if (el) {
      el.setAttribute('webkitdirectory', '');
      el.setAttribute('directory', '');
    }
  }, [enabled]);

  const toErr = (err: unknown): string =>
    err instanceof ApiError || err instanceof Error ? err.message : String(err);

  const handleToggle = async (next: boolean) => {
    setEnabled(next);
    if (!next && assignedPetId) {
      setBusy(true);
      try {
        await api.agents.setPet(agentId, null);
        setAssignedPetId(null);
        show({ kind: 'success', title: t.pet.disabledTitle });
      } catch (err) {
        show({ kind: 'error', title: t.pet.disableFailedTitle, body: toErr(err) });
        setEnabled(true);
      } finally {
        setBusy(false);
      }
    }
  };

  const handleSelect = async (petId: string) => {
    setBusy(true);
    try {
      await api.agents.setPet(agentId, petId);
      setAssignedPetId(petId);
      show({ kind: 'success', title: t.pet.selectedTitle });
    } catch (err) {
      show({ kind: 'error', title: t.pet.selectFailedTitle, body: toErr(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (petId: string, name: string) => {
    if (!(await confirmDialog({ title: t.pet.deleteConfirmTitle(name), body: t.pet.deleteConfirmBody, confirmLabel: t.common.delete }))) return;
    setBusy(true);
    try {
      await api.pets.remove(petId);
      await refresh();
      show({ kind: 'success', title: t.pet.deletedTitle(name) });
    } catch (err) {
      show({ kind: 'error', title: t.pet.deleteFailedTitle, body: toErr(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = '';
    if (!files.length) return;
    setBusy(true);
    try {
      const { manifest, spritesheet } = await parsePetPackage(files);
      await api.pets.create(manifest, spritesheet);
      await refresh();
      show({ kind: 'success', title: t.pet.uploadedTitle });
    } catch (err) {
      const body = err instanceof PetPackageError ? err.message : toErr(err);
      show({ kind: 'error', title: t.pet.uploadFailedTitle, body });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title="Agent Pet" size="md">
      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm text-og-1000">
          <input
            type="checkbox"
            checked={enabled}
            disabled={busy}
            onChange={(e) => void handleToggle(e.target.checked)}
          />
          {t.pet.enableLabel}
        </label>

        {!enabled ? (
          <p className="text-xs text-og-500">
            {t.pet.enableHint}
          </p>
        ) : (
          <>
            <div>
              <button
                type="button"
                onClick={() => dirInputRef.current?.click()}
                disabled={busy}
                className="btn-secondary"
              >
                {t.pet.uploadButton}
              </button>
              <input
                ref={dirInputRef}
                type="file"
                aria-label={t.pet.uploadInputAriaLabel}
                className="hidden"
                onChange={(e) => void handleUpload(e)}
              />
              <p className="mt-1 text-xs text-og-400">{t.pet.uploadDirHint}</p>
            </div>

            {loading ? (
              <p className="text-sm text-og-500">{t.common.loading}</p>
            ) : pets.length === 0 ? (
              <p className="text-sm text-og-500">{t.pet.emptyState}</p>
            ) : (
              <ul className="grid grid-cols-2 gap-2">
                {pets.map((pet) => {
                  const selected = pet.id === assignedPetId;
                  return (
                    <li
                      key={pet.id}
                      className={`flex items-center gap-2 rounded-md border p-2 ${
                        selected ? 'border-accent bg-accent-soft/40' : 'border-hairline'
                      }`}
                    >
                      <LazyVisible style={{ width: `${PET_DISPLAY_WIDTH}px`, height: `${PET_DISPLAY_HEIGHT}px` }}>
                        <AgentPet petId={pet.id} status="idle" label={pet.displayName} />
                      </LazyVisible>
                      <button
                        type="button"
                        onClick={() => void handleSelect(pet.id)}
                        disabled={busy || selected}
                        title={pet.description || pet.displayName}
                        className="min-w-0 flex-1 truncate text-left text-sm text-og-1000 hover:text-accent-hover disabled:cursor-default"
                      >
                        {pet.displayName}
                        {selected && <span className="ml-1 text-xs text-accent">{t.pet.currentMarker}</span>}
                      </button>
                      <button
                        type="button"
                        aria-label={t.pet.deleteAriaLabel(pet.displayName)}
                        onClick={() => void handleDelete(pet.id, pet.displayName)}
                        disabled={busy}
                        className="shrink-0 text-xs text-accent hover:underline disabled:opacity-50"
                      >
                        {t.common.delete}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
