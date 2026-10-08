/**
 * Build the Linux and Windows executables: `npm run binaries`.
 *
 *   npm run binaries                          every released one, from a fresh pack of this checkout
 *   npm run binaries -- --test                and run the one for this machine
 *   npm run binaries -- --target linux-x64    only some: linux-x64, linux-arm64, win-x64, win-arm64,
 *                                             or darwin-arm64, which is never released (the Mac app
 *                                             is) but lets a Mac try the loader
 *   node binaries/build.ts --server DIR       around a built package, as the Release workflow does
 *   node binaries/build.ts --check FILE       only run the checks, on an executable built elsewhere
 *
 * Each executable is the official Node.js binary for its platform, at the version
 * in `node-version` (the one the Mac app carries too), with `main.ts` and the
 * package injected as a single-executable application: Node runs the loader, and
 * the loader unpacks the package and starts its CLI. The downloads are checked
 * against the checksums nodejs.org publishes and kept in `binaries/build/`. The
 * blob injected is the same for every platform, and Node asks that the Node
 * making it be the version receiving it, so the pinned Node for this machine
 * makes it, whether or not this machine is a target.
 *
 * Builds on macOS and Linux, which have `tar`, `unzip` and `zip`. A Linux or
 * Windows executable can't run on a Mac, so `--test` there builds darwin-arm64 too.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';

import { packServer } from '../scripts/pack.ts';
import { dashboardsDir, type Manifest } from './main.ts';

const run = promisify(execFile);
const here = import.meta.dirname;
const root = resolve(here, '..');
const out = join(here, 'build');

/** The executables a release carries; the Mac app covers Apple silicon. */
const RELEASED = ['linux-x64', 'linux-arm64', 'win-x64', 'win-arm64'] as const;
const TARGETS = [...RELEASED, 'darwin-arm64'] as const;
type Target = (typeof TARGETS)[number];

/** Node's own string for injecting the blob; see its single-executable documentation. */
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/** Node's name for this machine, which is how the targets are named too. */
function hostTarget(): Target {
  const name = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  if (!(TARGETS as readonly string[]).includes(name)) throw new Error(`no executable is built for ${name}`);
  return name as Target;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(url: string, to: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  await writeFile(to, new Uint8Array(await response.arrayBuffer()));
}

/** The official Node.js `version` for `target`, downloaded, checked and unpacked once: its binary and licence. */
async function nodeFor(target: Target, version: string): Promise<{ node: string; license: string }> {
  const cache = join(out, `node-v${version}`);
  await mkdir(cache, { recursive: true });
  const sums = join(cache, 'SHASUMS256.txt');
  if (!(await exists(sums))) await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, sums);
  const name = `node-v${version}-${target}`;
  const windows = target.startsWith('win-');
  const archive = `${name}.${windows ? 'zip' : 'tar.gz'}`;
  const node = join(cache, name, ...(windows ? ['node.exe'] : ['bin', 'node']));
  const license = join(cache, name, 'LICENSE');
  if ((await exists(node)) && (await exists(license))) return { node, license };
  const file = join(cache, archive);
  if (!(await exists(file))) {
    console.log(`downloading Node.js ${version} for ${target}`);
    await download(`https://nodejs.org/dist/v${version}/${archive}`, file);
  }
  const expected = (await readFile(sums, 'utf8'))
    .split('\n')
    .find((line) => line.trim().endsWith(`  ${archive}`))
    ?.split(/\s+/)[0];
  const actual = createHash('sha256').update(await readFile(file)).digest('hex');
  if (!expected || expected !== actual) {
    await rm(file, { force: true });
    throw new Error(`${archive} doesn't match the checksum nodejs.org publishes; refusing to use it`);
  }
  if (windows) await run('unzip', ['-q', '-o', file, `${name}/node.exe`, `${name}/LICENSE`, '-d', cache]);
  else await run('tar', ['-xzf', file, '-C', cache, `${name}/bin/node`, `${name}/LICENSE`]);
  return { node, license };
}

/** Every file under `dir`, as paths from it with `/` between parts, in one order everywhere. */
async function filesUnder(dir: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...(await filesUnder(join(dir, entry.name), path)));
    else files.push(path);
  }
  return files;
}

/** What the loader is told about the package at `server`. */
async function describe(server: string): Promise<Manifest> {
  const { version } = JSON.parse(await readFile(join(server, 'package.json'), 'utf8')) as { version: string };
  const files = await filesUnder(server);
  const hash = createHash('sha256');
  for (const file of files) hash.update(file).update('\0').update(await readFile(join(server, file))).update('\0');
  return { version, hash: hash.digest('hex').slice(0, 12), files };
}

/** The executables for `targets`, each with the package at `server` inside: the binary itself, and the archive it ships in. */
async function build(server: string, targets: readonly Target[]): Promise<Map<Target, { binary: string; archive: string }>> {
  if (!(await exists(join(server, 'dist', 'cli.js')))) throw new Error(`${server} has no dist/cli.js; --server wants a built package`);
  const version = (await readFile(join(root, 'node-version'), 'utf8')).trim();
  const manifest = await describe(server);
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  // The loader, as the CommonJS Node runs from a single executable. Loaded here
  // rather than imported, so `--check` needs no packages installed.
  const { build: bundle } = await import('esbuild');
  await bundle({ entryPoints: [join(here, 'main.ts')], outfile: join(out, 'main.cjs'), format: 'cjs', platform: 'node', target: 'node24', logLevel: 'warning' });

  const assets: Record<string, string> = { 'manifest.json': join(out, 'manifest.json') };
  for (const file of manifest.files) assets[file] = join(server, ...file.split('/'));
  const config = {
    main: join(out, 'main.cjs'),
    output: join(out, 'sea.blob'),
    disableExperimentalSEAWarning: true,
    // Both would tie the blob to the Node that made it, and the blob is for every platform.
    useSnapshot: false,
    useCodeCache: false,
    assets,
  };
  await writeFile(join(out, 'sea-config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const maker = await nodeFor(hostTarget(), version);
  await run(maker.node, ['--experimental-sea-config', join(out, 'sea-config.json')]);
  console.log(`made the blob with Node.js ${version}: ${manifest.files.length} files of daily-focus ${manifest.version}, hash ${manifest.hash}`);

  const built = new Map<Target, { binary: string; archive: string }>();
  for (const target of targets) {
    const { node, license } = await nodeFor(target, version);
    const windows = target.startsWith('win-');
    const darwin = target.startsWith('darwin-');
    const stage = join(out, target);
    await rm(stage, { recursive: true, force: true });
    await mkdir(stage, { recursive: true });
    const binary = join(stage, windows ? 'daily-focus.exe' : 'daily-focus');
    await copyFile(node, binary);
    // Apple's signature seals the binary, so it goes before the blob and an ad hoc one after.
    if (darwin) await run('codesign', ['--remove-signature', binary]);
    const postject = join(root, 'node_modules', 'postject', 'dist', 'cli.js');
    const segment = darwin ? ['--macho-segment-name', 'NODE_SEA'] : [];
    await run(process.execPath, [postject, binary, 'NODE_SEA_BLOB', join(out, 'sea.blob'), '--sentinel-fuse', SENTINEL_FUSE, ...segment]);
    if (darwin) await run('codesign', ['--sign', '-', binary]);
    await chmod(binary, 0o755);
    // Node's licence, and those of what it bundles, go wherever Node does.
    await copyFile(join(root, 'LICENSE'), join(stage, 'LICENSE'));
    await copyFile(license, join(stage, 'LICENSE-node'));
    // An archive rather than the bare file: a download keeps no executable bit.
    const archive = join(out, `daily-focus-${target}.${windows ? 'zip' : 'tar.gz'}`);
    await rm(archive, { force: true });
    const names = [basename(binary), 'LICENSE', 'LICENSE-node'];
    if (windows) await run('zip', ['-q', '-j', '-X', archive, ...names.map((name) => join(stage, name))]);
    // Without the attributes a Mac puts on files, which GNU tar would warn about on every extract.
    else await run('tar', ['--no-xattrs', '-czf', archive, '-C', stage, ...names], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
    console.log(`built ${archive}`);
    built.set(target, { binary, archive });
  }
  return built;
}

/**
 * Run `binary` the way someone would, on this machine: `--version`, then the demo
 * until its dashboard answers and serves the sample brief from the files the
 * loader unpacked. In a home of its own, so that is where the build unpacks, and
 * nothing is left behind.
 */
async function check(binary: string): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'daily-focus-binary-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_DATA_HOME: join(home, 'share'), LOCALAPPDATA: join(home, 'local') };
  try {
    const version = (await run(binary, ['--version'], { env })).stdout.trim();
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`${binary} --version printed ${JSON.stringify(version)}`);
    console.log(`${basename(binary)} --version: ${version}`);

    const child = spawn(binary, ['--demo', '--no-open', '--port', '0'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      const url = await new Promise<string>((done, fail) => {
        let output = '';
        const timer = setTimeout(() => fail(new Error(`no dashboard line within 60s:\n${output}`)), 60_000);
        const read = (chunk: Buffer) => {
          output += chunk.toString();
          const match = /dashboard {2}(http:\/\/\S+)/.exec(output);
          if (match) {
            clearTimeout(timer);
            done(match[1]!);
          }
        };
        child.stdout.on('data', read);
        child.stderr.on('data', read);
        child.on('exit', (code) => fail(new Error(`exited ${code}:\n${output}`)));
      });
      const state = (await (await fetch(`${url}/api/state`)).json()) as { items: unknown[] };
      if (state.items.length === 0) throw new Error('the demo served no items');
      if ((await fetch(`${url}/app.js`)).status !== 200) throw new Error('the page is not served');
      const health = (await (await fetch(`${url}/api/health`)).json()) as { dataDir: string };
      const prompt = await readFile(join(health.dataDir, 'prompt.md'), 'utf8');
      if (!/morning brief/i.test(prompt)) throw new Error("the store doesn't link to the unpacked prompt");
    } finally {
      child.kill();
      await new Promise((done) => child.once('exit', done));
    }

    const dashboards = dashboardsDir(process.platform, env, home);
    const unpacked = await readdir(dashboards);
    if (unpacked.length !== 1 || !unpacked[0]!.startsWith(`${version}-`)) {
      throw new Error(`expected one build unpacked in ${dashboards}, found ${unpacked.join(', ') || 'none'}`);
    }
    console.log(`${basename(binary)} runs the demo from ${join(dashboards, unpacked[0]!)}`);
  } finally {
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  }
}

function target(name: string): Target {
  if (!(TARGETS as readonly string[]).includes(name)) throw new Error(`${name} is not a target; they are ${TARGETS.join(', ')}`);
  return name as Target;
}

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    target: { type: 'string' },
    test: { type: 'boolean', default: false },
    check: { type: 'string' },
  },
});

try {
  if (values.check) {
    await check(resolve(values.check));
  } else {
    const targets = values.target ? values.target.split(',').map(target) : [...RELEASED];
    if (values.test && !targets.includes(hostTarget())) targets.push(hostTarget());
    const packed = values.server ? null : await packServer();
    try {
      const built = await build(values.server ? resolve(values.server) : packed!.dir, targets);
      if (values.test) await check(built.get(hostTarget())!.binary);
    } finally {
      await packed?.done();
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
