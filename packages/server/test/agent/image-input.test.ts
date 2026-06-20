import { describe, it, expect, vi } from 'vitest';
import {
  detectImageType,
  decodeBase64Image,
  imageFilename,
  agentHostPath,
  writeImageToHost,
  ImageValidationError,
} from '../../src/agent/image-input.js';
import { SshRunner } from '../../src/agent/runner.js';
import { IMAGE_UPLOAD_MAX_BYTES } from '../../src/shared/constants.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]);
const GIF = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
  Buffer.from('WEBP', 'ascii'),
  Buffer.from([0, 0, 0, 0]),
]);

describe('detectImageType', () => {
  it('recognizes png/jpeg/gif/webp by magic bytes', () => {
    expect(detectImageType(PNG)).toEqual({ ext: 'png' });
    expect(detectImageType(JPEG)).toEqual({ ext: 'jpg' });
    expect(detectImageType(GIF)).toEqual({ ext: 'gif' });
    expect(detectImageType(WEBP)).toEqual({ ext: 'webp' });
  });

  it('returns null for non-image / empty buffers', () => {
    expect(detectImageType(Buffer.from('not an image at all'))).toBeNull();
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    // RIFF without WEBP tag (e.g. a WAV) must not pass.
    expect(detectImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))).toBeNull();
  });
});

describe('decodeBase64Image', () => {
  it('decodes a valid image and returns bytes + ext', () => {
    const { bytes, ext } = decodeBase64Image(PNG.toString('base64'));
    expect(ext).toBe('png');
    expect(bytes.equals(PNG)).toBe(true);
  });

  it('throws ImageValidationError on empty input', () => {
    expect(() => decodeBase64Image('')).toThrow(ImageValidationError);
  });

  it('throws ImageValidationError on non-image bytes', () => {
    expect(() => decodeBase64Image(Buffer.from('hello world').toString('base64'))).toThrow(
      ImageValidationError,
    );
  });

  it('throws ImageValidationError when over the size limit', () => {
    const big = Buffer.alloc(IMAGE_UPLOAD_MAX_BYTES + 16);
    PNG.copy(big);
    expect(() => decodeBase64Image(big.toString('base64'))).toThrow(/too large|size/i);
  });
});

describe('imageFilename / agentHostPath', () => {
  it('imageFilename is <uuid>.<ext>', () => {
    const fn = imageFilename('png');
    expect(fn).toMatch(/^[0-9a-f-]{36}\.png$/);
  });

  it('agentHostPath joins under /tmp/baxian/upload/<scope>/', () => {
    expect(agentHostPath('agent-1', 'a.png')).toBe('/tmp/baxian/upload/agent-1/a.png');
    expect(agentHostPath('task-007', 'b.webp')).toBe('/tmp/baxian/upload/task-007/b.webp');
  });
});

describe('writeImageToHost', () => {
  it('local runner → writeFile(path, bytes)', async () => {
    const runner = { exec: vi.fn(), writeFile: vi.fn().mockResolvedValue(undefined), execWithStdin: vi.fn() };
    await writeImageToHost(runner as never, '/tmp/baxian/upload/a/x.png', PNG);
    expect(runner.writeFile).toHaveBeenCalledWith('/tmp/baxian/upload/a/x.png', PNG);
  });

  it('SshRunner → pipes raw bytes via stdin (cat > path), never embeds bytes in argv (ARG_MAX)', async () => {
    const local = {
      exec: vi.fn(),
      writeFile: vi.fn(),
      execWithStdin: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
    };
    const ssh = new SshRunner({ hostname: 'h', user: 'u' }, local as never);
    const path = '/tmp/baxian/upload/task-1/x.png';
    const big = Buffer.alloc(5 * 1024 * 1024);
    PNG.copy(big);

    await writeImageToHost(ssh, path, big);

    expect(local.execWithStdin).toHaveBeenCalledTimes(1);
    const [command, stdin] = local.execWithStdin.mock.calls[0];
    expect(command).toContain('cat >');
    expect(command).toContain(path);
    expect((stdin as Buffer).equals(big)).toBe(true);
    // The bytes must NOT be embedded in the command string (would blow MAX_ARG_STRLEN).
    expect((command as string).includes(big.toString('base64'))).toBe(false);
    expect(Buffer.byteLength(command as string, 'utf8')).toBeLessThan(4096);
  });

  it('throws when the remote write exits non-zero (no silent failure)', async () => {
    const local = {
      exec: vi.fn(),
      writeFile: vi.fn(),
      execWithStdin: vi.fn().mockResolvedValue({ stdout: '', stderr: 'disk full', exitCode: 1 }),
    };
    const ssh = new SshRunner({ hostname: 'h' }, local as never);
    await expect(writeImageToHost(ssh, '/tmp/baxian/upload/t/x.png', PNG)).rejects.toThrow();
  });
});
