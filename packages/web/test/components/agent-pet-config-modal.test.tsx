import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PetMeta } from '../../src/shared/index.js';

vi.mock('../../src/components/toast.tsx', async () => (await import('../helpers/toast-mock.tsx')).createToastMock());
vi.mock('../../src/api.ts', async () => (await import('../helpers/api-mock.ts')).createApiMock());

import { api } from '../../src/api.ts';
import { AgentPetConfigModal, parsePetPackage, PetPackageError } from '../../src/components/agent-pet-config-modal.tsx';
import { ConfirmProvider } from '../../src/components/confirm-dialog.tsx';
import { toastShowMock } from '../helpers/toast-mock.tsx';
import { __resetI18nForTests, syncLocaleFromConfig } from '../../src/i18n/index.tsx';

const showMock = toastShowMock;
const listMock = vi.mocked(api.pets.list);
const removeMock = vi.mocked(api.pets.remove);
const createMock = vi.mocked(api.pets.create);
const setPetMock = vi.mocked(api.agents.setPet);
const fetchSpritesheetMock = vi.mocked(api.pets.fetchSpritesheet);

const PETS: PetMeta[] = [
  { id: 'pet-1', displayName: 'Foxy', description: 'a fox', ext: 'webp', createdAt: '1' },
  { id: 'pet-2', displayName: 'Cat', description: 'a cat', ext: 'png', createdAt: '2' },
];

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(PETS);
  removeMock.mockReset().mockResolvedValue(undefined);
  createMock.mockReset().mockResolvedValue(PETS[0]);
  setPetMock.mockReset().mockResolvedValue({ petId: null });
  fetchSpritesheetMock.mockReset().mockResolvedValue(new Blob(['x']));
  showMock.mockReset();
  (URL as unknown as { createObjectURL: () => string }).createObjectURL = vi.fn(() => 'blob:x');
  window.matchMedia = vi.fn().mockImplementation((q: string) => ({
    matches: true, media: q, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

function renderModal(currentPetId: string | null) {
  return render(
    <ConfirmProvider>
      <AgentPetConfigModal agentId="dev-1" currentPetId={currentPetId} onClose={vi.fn()} />
    </ConfirmProvider>,
  );
}

async function findConfirmDialog(): Promise<HTMLElement> {
  const dialogs = await screen.findAllByRole('dialog');
  return dialogs[dialogs.length - 1];
}

describe('parsePetPackage', () => {
  const file = (name: string, content: string) => new File([content], name);

  it('finds pet.json and the spritesheet named by spritesheetPath', async () => {
    const files = [file('pet.json', JSON.stringify({ displayName: 'F', spritesheetPath: 'spritesheet.webp' })), file('spritesheet.webp', 'IMG')];
    const { manifest, spritesheet } = await parsePetPackage(files);
    expect((manifest as { displayName: string }).displayName).toBe('F');
    expect(spritesheet.name).toBe('spritesheet.webp');
  });

  it('falls back to the first image when spritesheetPath is missing', async () => {
    const files = [file('pet.json', JSON.stringify({ displayName: 'F' })), file('art.png', 'IMG')];
    const { spritesheet } = await parsePetPackage(files);
    expect(spritesheet.name).toBe('art.png');
  });

  it('throws when pet.json is absent', async () => {
    await expect(parsePetPackage([file('spritesheet.webp', 'IMG')])).rejects.toBeInstanceOf(PetPackageError);
  });

  it('throws on invalid pet.json', async () => {
    await expect(parsePetPackage([file('pet.json', 'not json'), file('a.png', 'IMG')])).rejects.toThrow(/Failed to parse pet.json/);
  });

  it('throws when no spritesheet image is present', async () => {
    await expect(parsePetPackage([file('pet.json', JSON.stringify({ displayName: 'F' }))])).rejects.toThrow(/Spritesheet/);
  });

  describe('error messages follow the active locale', () => {
    afterEach(() => __resetI18nForTests());

    it('renders zh-CN error messages after syncLocaleFromConfig switches locale', async () => {
      syncLocaleFromConfig('zh-CN');
      await expect(parsePetPackage([file('spritesheet.webp', 'IMG')])).rejects.toThrow(/未找到 pet\.json/);
      await expect(parsePetPackage([file('pet.json', 'not json'), file('a.png', 'IMG')])).rejects.toThrow(/解析失败/);
      await expect(parsePetPackage([file('pet.json', JSON.stringify({ displayName: 'F' }))])).rejects.toThrow(/精灵图/);
    });
  });
});

describe('AgentPetConfigModal', () => {
  it('is disabled by default with no pet and shows the hint, no library', async () => {
    renderModal(null);
    const toggle = screen.getByLabelText('Enable Agent Pet') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/Once enabled, you can upload/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Foxy' })).toBeNull();
  });

  it('reveals the library when enabled and marks the current pet', async () => {
    renderModal('pet-1');
    const toggle = screen.getByLabelText('Enable Agent Pet') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(await screen.findByText('Foxy')).toBeTruthy();
    expect(screen.getByText('Cat')).toBeTruthy();
    expect(screen.getByText('(current)')).toBeTruthy();
  });

  it('assigns a pet on select', async () => {
    renderModal('pet-1');
    const catBtn = await screen.findByRole('button', { name: 'Cat' });
    await act(async () => { fireEvent.click(catBtn); });
    expect(setPetMock).toHaveBeenCalledWith('dev-1', 'pet-2');
  });

  it('clears the assignment when toggled off', async () => {
    renderModal('pet-1');
    const toggle = screen.getByLabelText('Enable Agent Pet');
    await act(async () => { fireEvent.click(toggle); });
    expect(setPetMock).toHaveBeenCalledWith('dev-1', null);
  });

  it('toggle-off clears even when opened with no pet (select before the snapshot lands)', async () => {
    renderModal(null);
    await act(async () => { fireEvent.click(screen.getByLabelText('Enable Agent Pet')); });
    const fox = await screen.findByRole('button', { name: 'Foxy' });
    await act(async () => { fireEvent.click(fox); });
    expect(setPetMock).toHaveBeenCalledWith('dev-1', 'pet-1');
    setPetMock.mockClear();
    await act(async () => { fireEvent.click(screen.getByLabelText('Enable Agent Pet')); });
    expect(setPetMock).toHaveBeenCalledWith('dev-1', null);
  });

  it('deletes a pet after confirmation and refreshes the list', async () => {
    renderModal('pet-1');
    const delBtn = await screen.findByRole('button', { name: 'Delete Cat' });
    await act(async () => { fireEvent.click(delBtn); });
    const dialog = await findConfirmDialog();
    expect(within(dialog).getByText('Delete pet "Cat"?')).toBeTruthy();
    expect(within(dialog).getByText('Agents using it will fall back to the default status display.')).toBeTruthy();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' })); });
    expect(removeMock).toHaveBeenCalledWith('pet-2');
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
  });

  it('shows the empty-library hint when no pet has been uploaded yet', async () => {
    listMock.mockResolvedValue([]);
    renderModal('pet-1');
    expect(await screen.findByText('No pets uploaded yet — click the button above to upload one.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Foxy' })).toBeNull();
  });

  it('re-checks the toggle and shows an error toast when clearing the pet fails', async () => {
    setPetMock.mockRejectedValue(new Error('server down'));
    renderModal('pet-1');
    const toggle = screen.getByLabelText('Enable Agent Pet') as HTMLInputElement;

    await act(async () => { fireEvent.click(toggle); });

    expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to disable', body: 'server down' });
    expect(toggle.checked).toBe(true);
    expect(await screen.findByText('(current)')).toBeTruthy();
  });

  it('keeps the previous assignment and shows an error toast when selecting a pet fails', async () => {
    setPetMock.mockRejectedValue(new Error('pet missing'));
    renderModal('pet-1');
    const catBtn = await screen.findByRole('button', { name: 'Cat' });

    await act(async () => { fireEvent.click(catBtn); });

    expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to select', body: 'pet missing' });
    expect(screen.getByText('(current)').closest('button')?.textContent).toContain('Foxy');
  });

  it('shows an error toast and skips the refresh when deleting a pet fails', async () => {
    removeMock.mockRejectedValue(new Error('pet in use'));
    renderModal('pet-1');
    const delBtn = await screen.findByRole('button', { name: 'Delete Cat' });

    await act(async () => { fireEvent.click(delBtn); });
    const dialog = await findConfirmDialog();
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' })); });

    expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to delete', body: 'pet in use' });
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  describe('pet package upload', () => {
    function uploadInput(): HTMLInputElement {
      return screen.getByLabelText('Upload Codex Pet package') as HTMLInputElement;
    }

    function changeFiles(files: File[]): void {
      fireEvent.change(uploadInput(), { target: { files } });
    }

    it('parses the package, creates the pet, refreshes the library and resets the input', async () => {
      renderModal('pet-1');
      await screen.findByText('Foxy');
      const manifest = new File([JSON.stringify({ displayName: 'New', spritesheetPath: 'sprite.webp' })], 'pet.json');
      const sprite = new File(['IMG'], 'sprite.webp');

      changeFiles([manifest, sprite]);

      await waitFor(() =>
        expect(createMock).toHaveBeenCalledWith({ displayName: 'New', spritesheetPath: 'sprite.webp' }, sprite));
      await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(showMock).toHaveBeenCalledWith({ kind: 'success', title: 'Pet uploaded' }));
      expect(uploadInput().value).toBe('');
    });

    it('reports a broken package (missing pet.json) without calling the API', async () => {
      renderModal('pet-1');
      await screen.findByText('Foxy');

      changeFiles([new File(['IMG'], 'sprite.webp')]);

      await waitFor(() =>
        expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to upload pet', body: 'pet.json not found in the file package' }));
      expect(createMock).not.toHaveBeenCalled();
    });

    it('reports an upload API failure as a toast', async () => {
      createMock.mockRejectedValue(new Error('payload too large'));
      renderModal('pet-1');
      await screen.findByText('Foxy');

      changeFiles([
        new File([JSON.stringify({ displayName: 'New' })], 'pet.json'),
        new File(['IMG'], 'art.png'),
      ]);

      await waitFor(() =>
        expect(showMock).toHaveBeenCalledWith({ kind: 'error', title: 'Failed to upload pet', body: 'payload too large' }));
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    it('ignores an empty file selection', async () => {
      renderModal('pet-1');
      await screen.findByText('Foxy');

      changeFiles([]);
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(createMock).not.toHaveBeenCalled();
      expect(showMock).not.toHaveBeenCalled();
    });
  });

  it('defers pet previews until they intersect the viewport', async () => {
    const observers: Array<{
      cb: (entries: { isIntersecting: boolean }[]) => void;
      disconnect: ReturnType<typeof vi.fn>;
      observed: Element[];
    }> = [];
    class MockIntersectionObserver {
      readonly disconnect = vi.fn();
      readonly observed: Element[] = [];
      constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
        observers.push({ cb, disconnect: this.disconnect, observed: this.observed });
      }
      observe(el: Element): void { this.observed.push(el); }
      unobserve(): void {}
      takeRecords(): never[] { return []; }
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    try {
      renderModal('pet-1');
      await screen.findByText('Foxy');

      expect(screen.queryByTitle('Foxy')).toBeNull();
      expect(observers).toHaveLength(2);
      expect(observers[0].observed).toHaveLength(1);

      await act(async () => {
        observers[0].cb([{ isIntersecting: true }]);
      });

      expect(screen.getByTitle('Foxy')).toBeTruthy();
      expect(observers[0].disconnect).toHaveBeenCalled();
      expect(screen.queryByTitle('Cat')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
