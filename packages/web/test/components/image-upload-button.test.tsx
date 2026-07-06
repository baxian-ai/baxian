import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { ImageUploadButton } from '../../src/components/image-upload-button.tsx';
import { ToastProvider } from '../../src/components/toast.tsx';
import { api } from '../../src/api.ts';
import { IMAGE_UPLOAD_MAX_BYTES } from '../../src/shared/index.ts';

function renderButton(agentId = 'dev-1') {
  return render(
    <ToastProvider>
      <ImageUploadButton agentId={agentId} />
    </ToastProvider>,
  );
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('input[type=file]') as HTMLInputElement;
}

const pngFile = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'x.png', { type: 'image/png' });

afterEach(() => vi.restoreAllMocks());

describe('ImageUploadButton', () => {
  it('renders an upload button', () => {
    renderButton();
    expect(screen.getByRole('button', { name: /Upload image/ })).toBeTruthy();
  });

  it('uploads the chosen file and shows a success toast', async () => {
    const spy = vi.spyOn(api.agents, 'uploadImage').mockResolvedValue({ path: '/tmp/baxian/upload/dev-1/x.png' });
    const { container } = renderButton('dev-1');
    const file = pngFile();

    fireEvent.change(fileInput(container), { target: { files: [file] } });

    await waitFor(() => expect(spy).toHaveBeenCalledWith('dev-1', file));
    expect(await screen.findByText(/Image inserted/)).toBeTruthy();
  });

  it('shows an error toast when upload fails (no silent failure)', async () => {
    vi.spyOn(api.agents, 'uploadImage').mockRejectedValue(new Error('boom'));
    const { container } = renderButton();

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    expect(await screen.findByText(/Failed to upload image/)).toBeTruthy();
  });

  it('rejects an oversized file client-side without calling the API', async () => {
    const spy = vi.spyOn(api.agents, 'uploadImage');
    const { container } = renderButton();
    const big = pngFile();
    Object.defineProperty(big, 'size', { value: IMAGE_UPLOAD_MAX_BYTES + 1 });

    fireEvent.change(fileInput(container), { target: { files: [big] } });

    expect(await screen.findByText(/Image too large/)).toBeTruthy();
    expect(spy).not.toHaveBeenCalled();
  });

  it('disables the button while an upload is in flight', async () => {
    let resolveUpload: (v: { path: string }) => void = () => undefined;
    vi.spyOn(api.agents, 'uploadImage').mockReturnValue(
      new Promise((resolve) => { resolveUpload = resolve; }),
    );
    const { container } = renderButton();

    fireEvent.change(fileInput(container), { target: { files: [pngFile()] } });

    await waitFor(() =>
      expect((screen.getByRole('button', { name: /Upload image/ }) as HTMLButtonElement).disabled).toBe(true),
    );
    resolveUpload({ path: '/tmp/baxian/upload/dev-1/x.png' });
  });
});
