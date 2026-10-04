import type { CommandRunner } from './runner.js';
import { shellQuote } from './runner.js';

export interface UntrackedFile {
  path: string;
  pathBase64: string;
  size: number;
  kind: 'file' | 'symlink' | 'directory';
}

export interface UntrackedFilesSnapshot {
  fingerprint: string;
  files: UntrackedFile[];
  conflicts: UntrackedFile[];
  trackedChanges: boolean;
}

export const UNTRACKED_FILES_TIMEOUT_MS = 15_000;
const OUTPUT_MARKER = 'BAXIAN_UNTRACKED_FILES:';

const SCRIPT = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
function run() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  const deadline = Date.now() + input.timeout;
  const checkDeadline = () => { if (Date.now() >= deadline) throw new Error('File inspection timed out; handle large artifacts in the terminal'); };
  const root = fs.realpathSync(input.workdir);
  const rootBytes = Buffer.from(root);
  const prefix = Buffer.from(root + '/');
  const git = (args, stdin) => {
    checkDeadline();
    return execFileSync('git', ['--no-optional-locks', args[0] === 'check-ignore' ? '--no-literal-pathspecs' : '--literal-pathspecs', '-C', root, ...args], {
      maxBuffer: 16 * 1024 * 1024, timeout: Math.max(1, Math.min(5000, deadline - Date.now())),
      input: stdin, stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
  };
  const split = bytes => {
    const parts = [];
    let start = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0) {
      if (i > start) parts.push(bytes.subarray(start, i));
      start = i + 1;
    }
    return parts;
  };
  const others = () => split(git(['ls-files', '--others', '--exclude-standard', '-z']));
  const trackedChanges = () => git(['status', '--porcelain=v1', '-z', '--untracked-files=no', '--ignore-submodules=none']).length > 0;
  if (fs.realpathSync(git(['rev-parse', '--show-toplevel']).toString('utf8').trim()) !== root) throw new Error('Workdir is not the repository root');
  if (input.pathsOnly) return { pathsBase64: others().map(p => p.toString('base64')), trackedChanges: trackedChanges() };
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const display = bytes => {
    const decoded = bytes.toString('utf8');
    if (Buffer.from(decoded).equals(bytes)) return decoded;
    return '[non-UTF-8] ' + [...bytes].map(b => b >= 32 && b < 127 && b !== 92 ? String.fromCharCode(b) : '\\x' + b.toString(16).padStart(2, '0')).join('');
  };
  function fullPath(relative) {
    const name = relative[relative.length - 1] === 47 ? relative.subarray(0, -1) : relative;
    if (!name.length || name[0] === 47 || name.includes(0)
      || name.toString('latin1').split('/').some(p => !p || p === '.' || p === '..' || p === '.git')) throw new Error('Invalid untracked path');
    const full = Buffer.concat([prefix, name]);
    const parent = fs.realpathSync(full.subarray(0, full.lastIndexOf(47)), { encoding: 'buffer' });
    if (!parent.equals(rootBytes) && !parent.subarray(0, prefix.length).equals(prefix)) throw new Error('Untracked path leaves the workdir');
    return full;
  }
  const identity = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs].map(String);
  function inspectFile(relative, full = fullPath(relative)) {
    checkDeadline();
    const stat = fs.lstatSync(full, { bigint: true });
    const kind = stat.isSymbolicLink() ? 'symlink' : stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : null;
    if (!kind) throw new Error('Unsupported untracked file type: ' + display(relative));
    const hash = crypto.createHash('sha256');
    if (kind === 'file') {
      const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const buffer = Buffer.alloc(64 * 1024);
        let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { checkDeadline(); hash.update(buffer.subarray(0, count)); }
        if (JSON.stringify(identity(stat)) !== JSON.stringify(identity(fs.fstatSync(fd, { bigint: true })))) throw new Error('File changed during inspection: ' + display(relative));
      } finally { fs.closeSync(fd); }
    } else if (kind === 'symlink') hash.update(fs.readlinkSync(full, { encoding: 'buffer' }));
    return { path: display(relative), pathBase64: relative.toString('base64'), size: Number(stat.size), kind, identity: [...identity(stat), hash.digest('hex')] };
  }
  function inspect() {
    const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none']).toString('base64');
    const paths = others().sort(Buffer.compare);
    if (paths.length > 10000) throw new Error('More than 10000 untracked files; reduce the file list in the terminal before continuing');
    const files = paths.map(relative => inspectFile(relative));
    const targets = [];
    for (const ref of input.targetRefs || []) {
      for (const candidate of Array.isArray(ref) ? ref : [ref]) {
        try {
          targets.push(git(['rev-parse', '--verify', '--end-of-options', candidate + '^{tree}']).toString('utf8').trim());
          break;
        } catch (error) { if (error.status !== 128 && error.status !== 1) throw error; }
      }
    }
    const conflicts = inspectConflicts(targets, files);
    return { fingerprint: digest(JSON.stringify([root, git(['rev-parse', 'HEAD']).toString('hex'), status, files, targets, conflicts])), files, conflicts, trackedChanges: trackedChanges() };
  }
  function inspectConflicts(targets, files) {
    if (!targets.length) return [];
    const tree = { children: new Map() };
    for (const ref of targets) for (const relative of split(git(['ls-tree', '-r', '--name-only', '-z', ref]))) {
      let node = tree;
      for (const segment of relative.toString('latin1').split('/')) {
        if (!node.children.has(segment)) node.children.set(segment, { children: new Map() });
        node = node.children.get(segment);
      }
      node.terminal = true;
    }
    const indexed = new Set(split(git(['ls-files', '--cached', '-z'])).map(p => p.toString('base64')));
    const byPath = new Map(files.map(file => [file.pathBase64, file]));
    const conflicts = new Map();
    const add = relative => {
      const key = relative.toString('base64');
      if (conflicts.size >= 10000) throw new Error('More than 10000 conflicting files; handle them in the terminal');
      conflicts.set(key, byPath.get(key) || inspectFile(relative));
    };
    function visit(relative, node) {
      checkDeadline();
      if (indexed.has(relative.toString('base64'))) return;
      const full = fullPath(relative);
      const stat = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!stat) return;
      if (!stat.isDirectory()) { add(relative); return; }
      const directory = Buffer.concat([relative, Buffer.from('/')]);
      if (byPath.get(directory.toString('base64'))?.kind === 'directory'
        || fs.existsSync(Buffer.concat([full, Buffer.from('/.git')]))) { add(directory); return; }
      if (node && !node.terminal) {
        for (const [segment, child] of node.children) visit(Buffer.concat([directory, Buffer.from(segment, 'latin1')]), child);
      } else {
        const stream = fs.opendirSync(full, { encoding: 'buffer' });
        try {
          let entry;
          while ((entry = stream.readSync()) !== null) visit(Buffer.concat([directory, entry.name]), null);
        } finally { stream.closeSync(); }
      }
    }
    for (const [segment, node] of tree.children) visit(Buffer.from(segment, 'latin1'), node);
    return [...conflicts.values()].sort((a, b) => Buffer.compare(Buffer.from(a.pathBase64, 'base64'), Buffer.from(b.pathBase64, 'base64')));
  }
  const snapshot = inspect();
  if (input.discard) {
    if (snapshot.fingerprint !== input.fingerprint) throw new Error('Files changed; refresh the list before discarding');
    const selected = snapshot.files.filter(f => input.discard.includes(f.pathBase64));
    if (selected.length !== input.discard.length || selected.some(f => f.kind === 'directory')) throw new Error('Only listed files and symlinks can be discarded');
    const indexPath = path.resolve(root, git(['rev-parse', '--git-path', 'index']).toString('utf8').trim());
    const indexIdentity = () => {
      try { return JSON.stringify(identity(fs.statSync(indexPath, { bigint: true }))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    };
    const expectedIndex = indexIdentity();
    const untracked = new Set(others().map(p => p.toString('base64')));
    let discarded = 0;
    try {
      for (const file of selected) {
        if (!untracked.has(file.pathBase64)) throw new Error('File is no longer untracked: ' + file.path);
        const relative = Buffer.from(file.pathBase64, 'base64');
        let ignored = true;
        try { git(['check-ignore', '--no-index', '--stdin', '-z'], Buffer.concat([Buffer.from('./'), relative, Buffer.from([0])])); }
        catch (error) { if (error.status === 1) ignored = false; else throw error; }
        if (ignored) throw new Error('File is now ignored: ' + file.path);
        if (JSON.stringify(inspectFile(relative)) !== JSON.stringify(file)) throw new Error('File changed before deletion: ' + file.path);
        if (indexIdentity() !== expectedIndex) throw new Error('Git index changed; refresh the file list');
        const full = fullPath(relative);
        const parent = full.subarray(0, full.lastIndexOf(47));
        const quarantine = fs.mkdtempSync(Buffer.concat([parent, Buffer.from('/.baxian-discard-')]), { encoding: 'buffer' });
        const saved = Buffer.concat([quarantine, Buffer.from('/'), full.subarray(full.lastIndexOf(47) + 1)]);
        let moved = false;
        try {
          fs.renameSync(full, saved);
          moved = true;
          const isolated = inspectFile(relative, saved);
          // rename may change ctime; inode, content and the remaining metadata must still match.
          if (isolated.identity.some((value, index) => index !== 5 && value !== file.identity[index])) throw new Error('File changed before deletion: ' + file.path);
          if (indexIdentity() !== expectedIndex) throw new Error('Git index changed; refresh the file list');
          fs.unlinkSync(saved);
          moved = false;
          discarded += 1;
        } catch (error) {
          if (moved) {
            try {
              if (fs.lstatSync(saved).isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(saved, { encoding: 'buffer' }), fullPath(relative));
              else fs.linkSync(saved, fullPath(relative));
              fs.unlinkSync(saved);
              moved = false;
            } catch (restoreError) {
              throw new Error('File preserved at ' + display(saved) + '; restore failed: ' + restoreError.message + '; ' + error.message);
            }
          }
          throw error;
        } finally { if (!moved) fs.rmdirSync(quarantine); }
      }
    } catch (error) {
      throw new Error(discarded + (discarded === 1 ? ' file was' : ' files were') + ' discarded before processing stopped: ' + (error.stderr ? error.stderr.toString('utf8').trim() : error.message));
    }
  }
  const publicFile = ({ identity, ...file }) => file;
  return { ...snapshot, files: snapshot.files.map(publicFile), conflicts: snapshot.conflicts.map(publicFile) };
}
try { console.log('BAXIAN_UNTRACKED_FILES:' + JSON.stringify(run())); }
catch (error) {
  const message = error.stderr ? error.stderr.toString('utf8').trim() : error.message;
  console.log('BAXIAN_UNTRACKED_FILES:' + JSON.stringify({ error: message.slice(0, 2000) }));
  process.exitCode = 1;
}
`;

async function runInspection(runner: CommandRunner, workdir: string, input: Record<string, unknown>) {
  const result = await runner.execWithStdin(`node -e ${shellQuote(SCRIPT)}`, Buffer.from(JSON.stringify({
    workdir, timeout: UNTRACKED_FILES_TIMEOUT_MS - 1000, ...input,
  })), { timeout: UNTRACKED_FILES_TIMEOUT_MS });
  const line = result.stdout.split('\n').reverse().find(line => line.startsWith(OUTPUT_MARKER));
  if (!line) throw new Error(`Untracked file inspection unavailable: ${result.stderr.trim().slice(0, 1000) || 'missing result; verify Node.js is available on the agent host'}`);
  const report = JSON.parse(line.slice(OUTPUT_MARKER.length));
  if (result.exitCode !== 0 || typeof report.error === 'string') throw new Error(`Untracked file inspection failed: ${report.error ?? 'remote command failed'}`);
  return report;
}

export async function untrackedFilePaths(runner: CommandRunner, workdir: string): Promise<{ pathsBase64: string[]; trackedChanges: boolean }> {
  return runInspection(runner, workdir, { pathsOnly: true });
}

export async function inspectUntrackedFiles(
  runner: CommandRunner,
  workdir: string,
  discard?: { fingerprint: string; pathsBase64: string[] },
  targetRefs: (string | string[])[] = [],
): Promise<UntrackedFilesSnapshot> {
  const snapshot = await runInspection(runner, workdir, {
    targetRefs, ...(discard ? { fingerprint: discard.fingerprint, discard: discard.pathsBase64 } : {}),
  }) as UntrackedFilesSnapshot;
  if (!Array.isArray(snapshot.files) || !Array.isArray(snapshot.conflicts) || !/^[a-f0-9]{64}$/.test(snapshot.fingerprint)) {
    throw new Error('Invalid untracked file inspection result');
  }
  return snapshot;
}
