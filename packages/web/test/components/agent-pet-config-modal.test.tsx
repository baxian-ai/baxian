import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { PetMeta } from '../../src/shared/index.js';

const showMock = vi.hoisted(() => vi.fn());
vi.mock('../../src/components/toast.tsx', () => ({ useToast: () => ({ show: showMock }) }));

const listMock = vi.fn();
const removeMock = vi.fn();
const createMock = vi.fn();
const setPetMock = vi.fn();
const fetchSpritesheetMock = vi.fn();
vi.mock('../../src/api.ts', () => ({
  ApiError: class ApiError extends Error {},
  api: {
    pets: {
      list: (...a: unknown[]) => listMock(...a),
      remove: (...a: unknown[]) => removeMock(...a),
      create: (...a: unknown[]) => createMock(...a),
      fetchSpritesheet: (...a: unknown[]) => fetchSpritesheetMock(...a),
    },
    agents: { setPet: (...a: unknown[]) => setPetMock(...a) },
  },
}));

import { AgentPetConfigModal, parsePetPackage, PetPackageError } from '../../src/components/agent-pet-config-modal.tsx';

const PETS: PetMeta[] = [
  { id: 'pet-1', displayName: 'Foxy', description: 'a fox', ext: 'webp', createdAt: '1' },
  { id: 'pet-2', displayName: 'Cat', description: 'a cat', ext: 'png', createdAt: '2' },
];

beforeEach(() => {
  listMock.mockReset().mockResolvedValue(PETS);
  removeMock.mockReset().mockResolvedValue(undefined);
  createMock.mockReset().mockResolvedValue({});
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
  return render(<AgentPetConfigModal agentId="dev-1" currentPetId={currentPetId} onClose={vi.fn()} />);
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
    await expect(parsePetPackage([file('pet.json', 'not json'), file('a.png', 'IMG')])).rejects.toThrow(/解析失败/);
  });

  it('throws when no spritesheet image is present', async () => {
    await expect(parsePetPackage([file('pet.json', JSON.stringify({ displayName: 'F' }))])).rejects.toThrow(/精灵图/);
  });
});

describe('AgentPetConfigModal', () => {
  it('is disabled by default with no pet and shows the hint, no library', async () => {
    renderModal(null);
    const toggle = screen.getByLabelText('启用 Agent Pet') as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(screen.getByText(/开启后可上传/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Foxy' })).toBeNull();
  });

  it('reveals the library when enabled and marks the current pet', async () => {
    renderModal('pet-1');
    const toggle = screen.getByLabelText('启用 Agent Pet') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    expect(await screen.findByText('Foxy')).toBeTruthy();
    expect(screen.getByText('Cat')).toBeTruthy();
    expect(screen.getByText('（当前）')).toBeTruthy();
  });

  it('assigns a pet on select', async () => {
    renderModal('pet-1');
    const catBtn = await screen.findByRole('button', { name: 'Cat' });
    await act(async () => { fireEvent.click(catBtn); });
    expect(setPetMock).toHaveBeenCalledWith('dev-1', 'pet-2');
  });

  it('clears the assignment when toggled off', async () => {
    renderModal('pet-1');
    const toggle = screen.getByLabelText('启用 Agent Pet');
    await act(async () => { fireEvent.click(toggle); });
    expect(setPetMock).toHaveBeenCalledWith('dev-1', null);
  });

  it('toggle-off clears even when opened with no pet (select before the snapshot lands)', async () => {
    renderModal(null);
    await act(async () => { fireEvent.click(screen.getByLabelText('启用 Agent Pet')); }); // enable
    const fox = await screen.findByRole('button', { name: 'Foxy' });
    await act(async () => { fireEvent.click(fox); }); // optimistic select; currentPetId prop stays null
    expect(setPetMock).toHaveBeenCalledWith('dev-1', 'pet-1');
    setPetMock.mockClear();
    await act(async () => { fireEvent.click(screen.getByLabelText('启用 Agent Pet')); }); // disable
    expect(setPetMock).toHaveBeenCalledWith('dev-1', null);
  });

  it('deletes a pet after confirmation and refreshes the list', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderModal('pet-1');
    const delBtn = await screen.findByRole('button', { name: '删除 Cat' });
    await act(async () => { fireEvent.click(delBtn); });
    expect(removeMock).toHaveBeenCalledWith('pet-2');
    await waitFor(() => expect(listMock).toHaveBeenCalledTimes(2)); // initial + refresh
    confirmSpy.mockRestore();
  });
});
