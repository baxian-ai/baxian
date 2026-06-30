import { randomUUID } from 'node:crypto';
import type { CommandRunner } from './runner.js';
import { SshRunner, shellQuote } from './runner.js';
import { AGENT_HOST_UPLOAD_DIR, IMAGE_UPLOAD_MAX_BYTES } from '../shared/constants.js';

export type ImageExt = 'png' | 'jpg' | 'gif' | 'webp';

export class ImageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageValidationError';
  }
}

export function detectImageType(buf: Buffer): { ext: ImageExt } | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png' };
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg' };
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { ext: 'gif' };
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp' };
  }
  return null;
}

export function decodeBase64Image(dataBase64: string): { bytes: Buffer; ext: ImageExt } {
  if (!dataBase64) throw new ImageValidationError('empty image payload');
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.length === 0) throw new ImageValidationError('empty image payload');
  if (bytes.length > IMAGE_UPLOAD_MAX_BYTES) {
    throw new ImageValidationError(
      `image too large: ${bytes.length} bytes > ${IMAGE_UPLOAD_MAX_BYTES} limit`,
    );
  }
  const detected = detectImageType(bytes);
  if (!detected) {
    throw new ImageValidationError('unsupported image type (allowed: png, jpg, gif, webp)');
  }
  return { bytes, ext: detected.ext };
}

export function imageFilename(ext: string): string {
  return `${randomUUID()}.${ext}`;
}

export function agentHostPath(scope: string, filename: string): string {
  return `${AGENT_HOST_UPLOAD_DIR}/${scope}/${filename}`;
}

export async function writeImageToHost(
  runner: CommandRunner,
  path: string,
  bytes: Buffer,
): Promise<void> {
  if (runner instanceof SshRunner) {
    const slash = path.lastIndexOf('/');
    const dir = slash > 0 ? path.slice(0, slash) : '/';
    const cmd = `mkdir -p ${shellQuote(dir)} && cat > ${shellQuote(path)}`;
    const r = await runner.execRawRemoteWithStdin(cmd, bytes);
    if (r.exitCode !== 0) {
      throw new Error(`writeImageToHost remote failed (${path}): ${r.stderr || 'unknown error'}`);
    }
    return;
  }
  await runner.writeFile(path, bytes);
}
