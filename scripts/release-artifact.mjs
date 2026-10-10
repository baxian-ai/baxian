import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = 'baxian-ai/baxian';
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function githubRequest(endpoint, token) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok && response.status !== 302) {
    throw new Error(`GitHub ${endpoint} failed: HTTP ${response.status}`);
  }
  return response;
}

async function verifyTestRun({ runId, sha, token, attempt }) {
  if (!/^[1-9]\d*$/.test(String(runId)) || !Number.isSafeInteger(Number(runId))) {
    throw new Error('a valid public test run ID is required');
  }
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('a full public commit SHA is required');
  if (!token) throw new Error('a GitHub token with actions:read is required');
  if (attempt !== undefined && (!/^[1-9]\d*$/.test(String(attempt)) || !Number.isSafeInteger(Number(attempt)))) {
    throw new Error('a valid public test run attempt is required');
  }
  const runPath = `actions/runs/${runId}`;
  const run = await (await githubRequest(runPath, token)).json();
  if (run.id !== Number(runId) || run.repository?.full_name !== repository
    || run.head_repository?.full_name !== repository || run.path !== '.github/workflows/test.yml'
    || run.event !== 'push' || run.head_branch !== 'main' || run.head_sha !== sha
    || run.status !== 'completed' || run.conclusion !== 'success'
    || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1) {
    throw new Error(`test run ${runId} must be a successful public main push for ${sha}`);
  }
  if (attempt !== undefined && run.run_attempt !== Number(attempt)) {
    throw new Error('public test run attempt changed; validate the package from the current successful attempt again');
  }
  return run;
}

export async function downloadTestedPackage({ runId, sha, version, outputDir, token }) {
  const run = await verifyTestRun({ runId, sha, token });
  const runPath = `actions/runs/${runId}`;

  const artifacts = [];
  for (let page = 1; ; page++) {
    const data = await (await githubRequest(`${runPath}/artifacts?per_page=100&page=${page}`, token)).json();
    artifacts.push(...data.artifacts);
    if (artifacts.length >= data.total_count || data.artifacts.length === 0) break;
  }
  const candidates = artifacts.filter((artifact) => artifact.name === `baxian-tarball-${run.run_attempt}`);
  if (candidates.length !== 1 || candidates[0].expired) {
    throw new Error(`test run ${runId} has no unique unexpired package for attempt ${run.run_attempt}; rerun the full public test workflow`);
  }
  const artifact = candidates[0];
  if (artifact.workflow_run?.id !== run.id || artifact.workflow_run?.head_sha !== sha
    || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest)) {
    throw new Error('release artifact has invalid source or digest metadata');
  }
  const redirect = await githubRequest(`actions/artifacts/${artifact.id}/zip`, token);
  const location = redirect.headers.get('location');
  if (redirect.status !== 302 || !location || new URL(location).protocol !== 'https:') {
    throw new Error('release artifact download did not return an HTTPS redirect');
  }
  const response = await fetch(location, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`release artifact download failed: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (`sha256:${sha256(archive)}` !== artifact.digest) throw new Error('release artifact digest mismatch');

  const temporary = await mkdtemp(path.join(tmpdir(), 'baxian-release-'));
  try {
    const archivePath = path.join(temporary, 'artifact.zip');
    await writeFile(archivePath, archive);
    const { stdout: listing } = await exec('unzip', ['-Z1', archivePath]);
    const entries = listing.trimEnd().split('\n');
    if (entries.length !== 1 || entries[0] !== `baxian-${version}.tgz`
      || path.basename(entries[0]) !== entries[0]) {
      throw new Error('release artifact must contain exactly the expected baxian tarball');
    }
    const filename = entries[0];
    const { stdout: tarball } = await exec('unzip', ['-p', archivePath, filename], {
      encoding: 'buffer', maxBuffer: 128 * 1024 * 1024,
    });
    const packagePath = path.join(temporary, filename);
    await writeFile(packagePath, tarball);
    const { stdout: metadata } = await exec('tar', ['-xOf', packagePath, 'package/package.json']);
    const pkg = JSON.parse(metadata);
    if (pkg.name !== 'baxian' || pkg.version !== version) throw new Error('release package name or version mismatch');
    const latest = await (await githubRequest(runPath, token)).json();
    if (latest.run_attempt !== run.run_attempt || latest.status !== 'completed' || latest.conclusion !== 'success') {
      throw new Error('public test run changed while downloading; retry after the current attempt succeeds');
    }
    await mkdir(outputDir, { recursive: true });
    await writeFile(path.join(outputDir, filename), tarball, { flag: 'wx' });
    console.log(`Verified ${filename} from public test run ${runId}, attempt ${run.run_attempt}, commit ${sha}`);
    return { sha256: sha256(tarball), runId: run.id, attempt: run.run_attempt };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function main(env = process.env, args = []) {
  if (env.GITHUB_REPOSITORY !== repository || env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('release artifacts may only be consumed on public main');
  }
  if (env.GITHUB_EVENT_NAME === 'repository_dispatch' && env.BAXIAN_PUBLIC_SHA !== env.GITHUB_SHA) {
    throw new Error('public main changed after dispatch; release the current tested commit');
  }
  if (args.length === 1 && args[0] === '--verify-run') {
    if (!env.BAXIAN_TEST_RUN_ATTEMPT) throw new Error('a validated public test run attempt is required');
    await verifyTestRun({
      runId: env.BAXIAN_TEST_RUN_ID, sha: env.GITHUB_SHA, token: env.GH_TOKEN,
      attempt: env.BAXIAN_TEST_RUN_ATTEMPT,
    });
    return;
  }
  if (args.length) throw new Error('unknown release artifact arguments');
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const result = await downloadTestedPackage({
    runId: env.BAXIAN_TEST_RUN_ID, sha: env.GITHUB_SHA, version: pkg.version,
    outputDir: 'release-package', token: env.GH_TOKEN,
  });
  await appendFile(env.GITHUB_OUTPUT, `sha256=${result.sha256}\ntest-run-id=${result.runId}\ntest-run-attempt=${result.attempt}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.env, process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
