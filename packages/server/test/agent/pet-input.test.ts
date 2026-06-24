import { describe, it, expect } from 'vitest';
import {
  decodePetSpritesheet,
  PetValidationError,
  readImageSize,
  validatePetManifest,
} from '../../src/agent/pet-input.js';
import { PET_ATLAS_HEIGHT, PET_ATLAS_WIDTH, PET_SPRITESHEET_MAX_BYTES } from '../../src/shared/index.js';

function makePng(width: number, height: number): Buffer {
  const b = Buffer.alloc(33);
  [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].forEach((v, i) => (b[i] = v));
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function makeWebpVP8L(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8L', 12, 'ascii');
  b[20] = 0x2f;
  const w1 = width - 1;
  const h1 = height - 1;
  b[21] = w1 & 0xff;
  b[22] = ((w1 >> 8) & 0x3f) | ((h1 & 0x3) << 6);
  b[23] = (h1 >> 2) & 0xff;
  b[24] = (h1 >> 10) & 0x0f;
  return b;
}

function makeWebpVP8X(width: number, height: number): Buffer {
  const b = Buffer.alloc(30);
  b.write('RIFF', 0, 'ascii');
  b.write('WEBP', 8, 'ascii');
  b.write('VP8X', 12, 'ascii');
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

const b64 = (buf: Buffer): string => buf.toString('base64');

describe('validatePetManifest', () => {
  it('accepts a minimal valid manifest and trims', () => {
    const m = validatePetManifest({ displayName: '  Foxy  ', description: ' a fox ', spritesheetPath: 'spritesheet.webp' });
    expect(m).toEqual({ displayName: 'Foxy', description: 'a fox' });
  });

  it('allows an empty description and an absent spritesheetPath', () => {
    expect(validatePetManifest({ displayName: 'Foxy' })).toEqual({ displayName: 'Foxy', description: '' });
  });

  it.each([
    [null, /JSON object/],
    [{}, /displayName is required/],
    [{ displayName: '   ' }, /displayName is required/],
    [{ displayName: 'x'.repeat(81) }, /displayName too long/],
    [{ displayName: 'Foxy', description: 'd'.repeat(501) }, /description too long/],
    [{ displayName: 'Foxy', spritesheetPath: 42 }, /spritesheetPath must be a string/],
  ] as const)('rejects %#', (raw, match) => {
    expect(() => validatePetManifest(raw)).toThrow(match as RegExp);
  });
});

describe('readImageSize', () => {
  it('reads PNG dimensions', () => {
    expect(readImageSize(makePng(1536, 1872))).toEqual({ width: 1536, height: 1872 });
    expect(readImageSize(makePng(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('reads WebP VP8L dimensions', () => {
    expect(readImageSize(makeWebpVP8L(1536, 1872))).toEqual({ width: 1536, height: 1872 });
    expect(readImageSize(makeWebpVP8L(123, 456))).toEqual({ width: 123, height: 456 });
  });

  it('reads WebP VP8X dimensions', () => {
    expect(readImageSize(makeWebpVP8X(1536, 1872))).toEqual({ width: 1536, height: 1872 });
  });

  it('returns null for non-image / truncated bytes', () => {
    expect(readImageSize(Buffer.from('not an image'))).toBeNull();
    expect(readImageSize(Buffer.alloc(4))).toBeNull();
  });
});

describe('decodePetSpritesheet', () => {
  it('accepts a 1536×1872 PNG', () => {
    const r = decodePetSpritesheet(b64(makePng(PET_ATLAS_WIDTH, PET_ATLAS_HEIGHT)));
    expect(r.ext).toBe('png');
  });

  it('accepts a 1536×1872 WebP', () => {
    const r = decodePetSpritesheet(b64(makeWebpVP8L(PET_ATLAS_WIDTH, PET_ATLAS_HEIGHT)));
    expect(r.ext).toBe('webp');
  });

  it('rejects an empty payload', () => {
    expect(() => decodePetSpritesheet('')).toThrow(PetValidationError);
  });

  it('rejects a non-image payload', () => {
    expect(() => decodePetSpritesheet(b64(Buffer.from('hello world hello world')))).toThrow(/unsupported spritesheet type/);
  });

  it('rejects wrong dimensions', () => {
    expect(() => decodePetSpritesheet(b64(makePng(1024, 1024)))).toThrow(/must be 1536×1872/);
  });

  it('rejects an oversized payload', () => {
    const big = Buffer.alloc(PET_SPRITESHEET_MAX_BYTES + 1);
    [0x89, 0x50, 0x4e, 0x47].forEach((v, i) => (big[i] = v));
    expect(() => decodePetSpritesheet(b64(big))).toThrow(/too large/);
  });
});
