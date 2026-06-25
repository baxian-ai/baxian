import { useEffect, useState } from 'react';
import type { AgentRuntimeStatus } from '../shared/index.js';
import {
  PET_ATLAS_HEIGHT,
  PET_ATLAS_WIDTH,
  PET_CELL_HEIGHT,
  PET_CELL_WIDTH,
} from '../shared/index.js';
import { usePetSpritesheet } from '../hooks/use-pets.ts';

export interface PetAnimationRow {
  state: string;
  row: number;
  /** Per-frame hold time in ms; length is the used frame count for the row. */
  durations: number[];
}

// hatch-pet animation contract (references/animation-rows.md). Frame counts and
// per-frame durations differ by row; trailing cells are transparent, so the renderer
// must cycle ONLY durations.length frames or the pet flickers through empty cells.
export const PET_ANIMATION_ROWS: readonly PetAnimationRow[] = [
  { state: 'idle', row: 0, durations: [280, 110, 110, 140, 140, 320] },
  { state: 'running-right', row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { state: 'running-left', row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] },
  { state: 'waving', row: 3, durations: [140, 140, 140, 280] },
  { state: 'jumping', row: 4, durations: [140, 140, 140, 140, 280] },
  { state: 'failed', row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] },
  { state: 'waiting', row: 6, durations: [150, 150, 150, 150, 150, 260] },
  { state: 'running', row: 7, durations: [120, 120, 120, 120, 120, 220] },
  { state: 'review', row: 8, durations: [150, 150, 150, 150, 150, 280] },
];

export function petRowForStatus(status: AgentRuntimeStatus, bootstrapping: boolean): number {
  if (bootstrapping) return 3; // waving while the agent starts up
  switch (status) {
    case 'working': return 7;
    case 'waiting': return 6;
    case 'pending': return 6;
    case 'error': return 5;
    case 'idle': return 0;
    case 'unknown': return 0;
    default: return 0;
  }
}

export const PET_DISPLAY_HEIGHT = 36;
const SCALE = PET_DISPLAY_HEIGHT / PET_CELL_HEIGHT;
export const PET_DISPLAY_WIDTH = PET_CELL_WIDTH * SCALE;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export interface AgentPetProps {
  petId: string;
  status: AgentRuntimeStatus;
  bootstrapping?: boolean;
  /** Human-readable status text — used as the accessible label and the loading fallback. */
  label: string;
  displayHeight?: number;
  className?: string;
}

export function AgentPet({ petId, status, bootstrapping = false, label, displayHeight = PET_DISPLAY_HEIGHT, className }: AgentPetProps) {
  const url = usePetSpritesheet(petId);
  const row = petRowForStatus(status, bootstrapping);
  const def = PET_ANIMATION_ROWS[row];
  const frames = def.durations.length;
  const [col, setCol] = useState(0);
  const scale = displayHeight / PET_CELL_HEIGHT;
  const displayWidth = PET_CELL_WIDTH * scale;

  useEffect(() => {
    setCol(0);
    if (!url || frames <= 1 || prefersReducedMotion()) return;
    let timer: ReturnType<typeof setTimeout>;
    let i = 0;
    const advance = () => {
      i = (i + 1) % frames;
      setCol(i);
      timer = setTimeout(advance, def.durations[i]);
    };
    timer = setTimeout(advance, def.durations[0]);
    return () => clearTimeout(timer);
  }, [url, row, frames, def]);

  if (!url) {
    return <span className="pill pill-idle" title={label}>{label}</span>;
  }

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      data-pet-row={row}
      data-pet-col={col}
      className={['inline-block shrink-0', className].filter(Boolean).join(' ')}
      style={{
        width: `${displayWidth}px`,
        height: `${displayHeight}px`,
        backgroundImage: `url(${url})`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${PET_ATLAS_WIDTH * scale}px ${PET_ATLAS_HEIGHT * scale}px`,
        backgroundPositionX: `${-(col * displayWidth)}px`,
        backgroundPositionY: `${-(row * displayHeight)}px`,
        imageRendering: 'pixelated',
      }}
    />
  );
}
