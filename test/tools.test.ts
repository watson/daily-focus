/**
 * Fetching gh and acli for a user who has neither, with the network and the
 * programs it runs stood in for: which copy wins, what is checked, and where it
 * lands. Nothing here reaches GitHub or Atlassian.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { fetchedPath, fetchTool, resolveTool, type FetchDeps } from '../src/tools.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function toolsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-tools-'));
  dirs.push(dir);
  return join(dir, 'tools');
}

test("a CLI of the user's own wins; the fetched copy only when there is none", () => {
  const dir = join('/data', 'tools');
  const fetched = fetchedPath('gh', dir, 'darwin');
  const has = (...paths: string[]) => (path: string) => paths.includes(path);
  assert.deepEqual(resolveTool('gh', 'gh', dir, { onPath: () => true, exists: has(fetched), platform: 'darwin' }), { path: 'gh', found: true, fetched: false });
  assert.deepEqual(resolveTool('gh', 'gh', dir, { onPath: () => false, exists: has(fetched), platform: 'darwin' }), { path: fetched, found: true, fetched: true });
  assert.deepEqual(resolveTool('gh', 'gh', dir, { onPath: () => false, exists: has(), platform: 'darwin' }), { path: 'gh', found: false, fetched: false });
  assert.deepEqual(
    resolveTool('gh', '/opt/gh/bin/gh', dir, { onPath: () => false, exists: has('/opt/gh/bin/gh', fetched), platform: 'darwin' }),
    { path: '/opt/gh/bin/gh', found: true, fetched: false },
    'one Settings names, even beside a fetched copy',
  );
  assert.equal(fetchedPath('acli', dir, 'win32'), join(dir, 'bin', 'acli.exe'));
});

/** A world with one gh release in it, and the programs fetching runs. */
function ghWorld(opts: { platform: NodeJS.Platform; arch?: string; checksum?: string; signer?: string }) {
  const os = { darwin: 'macOS', linux: 'linux', win32: 'windows' }[opts.platform as string]!;
  const asset = `gh_2.99.0_${os}_arm64.${opts.platform === 'linux' ? 'tar.gz' : 'zip'}`;
  const archive = Buffer.from('an archive');
  const sum = opts.checksum ?? createHash('sha256').update(archive).digest('hex');
  const fetched: string[] = [];
  const ran: string[][] = [];
  const deps: FetchDeps = {
    platform: opts.platform,
    arch: opts.arch ?? 'arm64',
    fetch: (async (url: string) => {
      fetched.push(url);
      if (url.endsWith('/releases/latest')) return new Response(null, { status: 302, headers: { location: 'https://github.com/cli/cli/releases/tag/v2.99.0' } });
      if (url.endsWith(`/${asset}`)) return new Response(archive);
      if (url.endsWith('/gh_2.99.0_checksums.txt')) return new Response(`${'0'.repeat(64)}  gh_2.99.0_other.zip\n${sum}  ${asset}\n`);
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch,
    run: async (file, args) => {
      ran.push([file, ...args]);
      if (file === 'tar') {
        // As gh's archives lay it out: in a folder of the release's name, or at the top on Windows.
        const into = args[args.indexOf('-C') + 1]!;
        const bin = opts.platform === 'win32' ? join(into, 'bin') : join(into, `gh_2.99.0_${os}_arm64`, 'bin');
        await mkdir(bin, { recursive: true });
        await writeFile(join(bin, opts.platform === 'win32' ? 'gh.exe' : 'gh'), 'gh itself');
        return '';
      }
      if (file === '/usr/bin/codesign') return '';
      if (file === 'powershell.exe') return opts.signer ?? 'Valid|CN="GitHub, Inc.", O="GitHub, Inc.", L=San Francisco, S=California, C=US';
      if (args[0] === '--version') return 'gh version 2.99.0 (2026-09-30)\n';
      throw new Error(`unexpected ${file}`);
    },
  };
  return { deps, fetched, ran, asset };
}

test("gh is fetched from GitHub's newest release, checked against its checksums, and put in place", async () => {
  const dir = await toolsDir();
  const world = ghWorld({ platform: 'linux' });
  assert.equal(await fetchTool('gh', dir, world.deps), '2.99.0');
  assert.ok(existsSync(fetchedPath('gh', dir, 'linux')));
  assert.deepEqual(await readdir(dir), ['bin'], 'nothing left from the fetch but what it fetched');
  assert.equal(world.fetched[0], 'https://github.com/cli/cli/releases/latest');
  assert.deepEqual(world.fetched.slice(1).sort(), [
    'https://github.com/cli/cli/releases/download/v2.99.0/gh_2.99.0_checksums.txt',
    `https://github.com/cli/cli/releases/download/v2.99.0/${world.asset}`,
  ]);
});

test('a gh whose checksum is wrong is refused, and nothing is put in place', async () => {
  const dir = await toolsDir();
  const world = ghWorld({ platform: 'linux', checksum: 'f'.repeat(64) });
  await assert.rejects(fetchTool('gh', dir, world.deps), /doesn't match the checksum its release publishes/);
  assert.equal(existsSync(fetchedPath('gh', dir, 'linux')), false);
});

test("on macOS each is checked against its maker's Developer ID", async () => {
  const dir = await toolsDir();
  const world = ghWorld({ platform: 'darwin' });
  await fetchTool('gh', dir, world.deps);
  const codesign = world.ran.find(([file]) => file === '/usr/bin/codesign')!;
  assert.ok(codesign.some((arg) => arg.includes('leaf[subject.OU] = "VEKTX9H2N7"')), codesign.join(' '));

  const refused = ghWorld({ platform: 'darwin' });
  const run = refused.deps.run;
  refused.deps.run = async (file, args) => {
    if (file === '/usr/bin/codesign') throw new Error('test-requirement: code failed to satisfy specified code requirement(s)');
    return run(file, args);
  };
  const other = await toolsDir();
  await assert.rejects(fetchTool('gh', other, refused.deps), /the GitHub CLI that was downloaded isn't signed by its maker/);
  assert.equal(existsSync(fetchedPath('gh', other, 'darwin')), false);
});

test("on Windows gh is checked against GitHub's Authenticode signature, from where its archive puts it", async () => {
  const dir = await toolsDir();
  const world = ghWorld({ platform: 'win32' });
  assert.equal(await fetchTool('gh', dir, world.deps), '2.99.0');
  assert.ok(existsSync(fetchedPath('gh', dir, 'win32')));
  assert.ok(world.ran.some(([file]) => file === 'powershell.exe'));

  const unsigned = ghWorld({ platform: 'win32', signer: 'NotSigned|' });
  await assert.rejects(fetchTool('gh', await toolsDir(), unsigned.deps), /isn't signed by its maker/);
  const someoneElse = ghWorld({ platform: 'win32', signer: 'Valid|CN="Contoso", O="Contoso", C=US' });
  await assert.rejects(fetchTool('gh', await toolsDir(), someoneElse.deps), /isn't signed by its maker/);
});

test("acli is Atlassian's newest, by its own address for each platform, and has no Windows signature to check", async () => {
  for (const [platform, arch, url] of [
    ['darwin', 'arm64', 'https://acli.atlassian.com/darwin/latest/acli_darwin_arm64/acli'],
    ['linux', 'x64', 'https://acli.atlassian.com/linux/latest/acli_linux_amd64/acli'],
    ['win32', 'arm64', 'https://acli.atlassian.com/windows/latest/acli_windows_arm64/acli.exe'],
  ] as const) {
    const dir = await toolsDir();
    const fetched: string[] = [];
    const ran: string[] = [];
    const deps: FetchDeps = {
      platform,
      arch,
      fetch: (async (url: string) => (fetched.push(url), new Response('acli itself'))) as unknown as typeof fetch,
      run: async (file, args) => (ran.push(file), args[0] === '--version' ? 'acli version 1.3.39-stable\n' : ''),
    };
    assert.equal(await fetchTool('acli', dir, deps), '1.3.39-stable');
    assert.deepEqual(fetched, [url]);
    assert.ok(existsSync(fetchedPath('acli', dir, platform)));
    assert.equal(ran.includes('powershell.exe'), false, `${platform}: Atlassian signs no Windows build to check`);
    assert.equal(ran.includes('/usr/bin/codesign'), platform === 'darwin');
  }
});

test('a platform a CLI is not made for is said so, before anything is fetched', async () => {
  const deps: FetchDeps = {
    platform: 'freebsd',
    arch: 'x64',
    fetch: (async () => assert.fail('fetched')) as unknown as typeof fetch,
    run: async () => '',
  };
  await assert.rejects(fetchTool('acli', await toolsDir(), deps), /the Atlassian CLI isn't made for freebsd on x64/);
  await assert.rejects(fetchTool('gh', await toolsDir(), { ...deps, platform: 'linux', arch: 'ia32' }), /isn't made for linux on ia32/);
});
