import { useRef, useState, type ChangeEvent } from 'react';
import { api, ApiError } from '../api.ts';
import { IMAGE_UPLOAD_MAX_BYTES } from '../shared/index.ts';
import { useToast } from './toast.tsx';
import { useT } from '../i18n/index.tsx';

export interface ImageUploadButtonProps {
  agentId: string;
  className?: string;
}

const MAX_MIB = Math.floor(IMAGE_UPLOAD_MAX_BYTES / 1024 / 1024);

export function ImageUploadButton({ agentId, className }: ImageUploadButtonProps) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const { show } = useToast();

  const onPick = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > IMAGE_UPLOAD_MAX_BYTES) {
      show({ kind: 'error', title: t.createTask.imageTooLargeToastTitle, body: t.imageUpload.tooLargeBody(MAX_MIB) });
      return;
    }
    setUploading(true);
    try {
      await api.agents.uploadImage(agentId, file);
      show({ kind: 'success', title: t.imageUpload.insertedTitle, body: t.imageUpload.insertedBody });
    } catch (err) {
      const body = err instanceof ApiError || err instanceof Error ? err.message : String(err);
      show({ kind: 'error', title: t.imageUpload.uploadFailedTitle, body });
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <button
        type="button"
        aria-label={t.imageUpload.uploadAriaLabel}
        disabled={uploading}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
        className={
          className ??
          'flex h-8 w-8 items-center justify-center rounded border border-hairline bg-surface text-og-700 transition-colors hover:bg-og-50 hover:text-og-1000 active:bg-og-200 disabled:cursor-not-allowed disabled:opacity-50'
        }
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="9" cy="9" r="2" />
          <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={onPick}
      />
    </>
  );
}
