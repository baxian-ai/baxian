import {
  PET_ATLAS_HEIGHT,
  PET_ATLAS_WIDTH,
  PET_DESCRIPTION_MAX,
  PET_DISPLAY_NAME_MAX,
  PET_SPRITESHEET_MAX_BYTES,
  isRecord,
} from '../shared/index.js';
import type { PetSpritesheetExt } from '../shared/index.js';

export class PetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PetValidationError';
  }
}

export interface PetManifest {
  displayName: string;
  description: string;
}

export function validatePetManifest(raw: unknown): PetManifest {
  if (!isRecord(raw)) throw new PetValidationError('pet.json must be a JSON object');
  const displayName = typeof raw.displayName === 'string' ? raw.displayName.trim() : '';
  if (!displayName) throw new PetValidationError('pet.json: displayName is required');
  if (displayName.length > PET_DISPLAY_NAME_MAX) {
    throw new PetValidationError(`pet.json: displayName too long (> ${PET_DISPLAY_NAME_MAX})`);
  }
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.length > PET_DESCRIPTION_MAX) {
    throw new PetValidationError(`pet.json: description too long (> ${PET_DESCRIPTION_MAX})`);
  }
  if (raw.spritesheetPath !== undefined && typeof raw.spritesheetPath !== 'string') {
    throw new PetValidationError('pet.json: spritesheetPath must be a string');
  }
  return { displayName, description };
}

function detectSpritesheetExt(buf: Buffer): PetSpritesheetExt | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'png';
  }
  if (
    buf.length >= 12 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'webp';
  }
  return null;
}

export function readImageSize(buf: Buffer): { width: number; height: number } | null {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (
    buf.length >= 16 &&
    buf.toString('ascii', 0, 4) === 'RIFF' &&
    buf.toString('ascii', 8, 12) === 'WEBP'
  ) {
    const fourcc = buf.toString('ascii', 12, 16);
    if (fourcc === 'VP8 ') {
      if (buf.length < 30) return null;
      if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return null;
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
    if (fourcc === 'VP8L') {
      if (buf.length < 25 || buf[20] !== 0x2f) return null;
      const b0 = buf[21], b1 = buf[22], b2 = buf[23], b3 = buf[24];
      const width = 1 + (((b1 & 0x3f) << 8) | b0);
      const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
      return { width, height };
    }
    if (fourcc === 'VP8X') {
      if (buf.length < 30) return null;
      return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
    }
  }
  return null;
}

export function decodePetSpritesheet(dataBase64: string): { bytes: Buffer; ext: PetSpritesheetExt } {
  if (!dataBase64) throw new PetValidationError('empty spritesheet payload');
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length === 0) throw new PetValidationError('empty spritesheet payload');
  if (bytes.length > PET_SPRITESHEET_MAX_BYTES) {
    throw new PetValidationError(
      `spritesheet too large: ${bytes.length} bytes > ${PET_SPRITESHEET_MAX_BYTES} limit`,
    );
  }
  const ext = detectSpritesheetExt(bytes);
  if (!ext) throw new PetValidationError('unsupported spritesheet type (allowed: png, webp)');
  const size = readImageSize(bytes);
  if (!size) throw new PetValidationError('unreadable spritesheet image header');
  if (size.width !== PET_ATLAS_WIDTH || size.height !== PET_ATLAS_HEIGHT) {
    throw new PetValidationError(
      `spritesheet must be ${PET_ATLAS_WIDTH}×${PET_ATLAS_HEIGHT} (got ${size.width}×${size.height})`,
    );
  }
  return { bytes, ext };
}
