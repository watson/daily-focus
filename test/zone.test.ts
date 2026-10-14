/**
 * The dashboard's zone: the one a browser last reported, or the Mac's if it has
 * moved since, kept across restarts. Every case sets the Mac's zone by hand, so
 * none depends on where the tests run.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';

import { startServer, type StartedServer } from '../src/server.ts';
import { localTimeZone } from '../src/time.ts';
import { readSystemZone, startingZone, TimeZoneKeeper, validZone } from '../src/zone.ts';

const originalTZ = process.env.TZ;
const startedIn = localTimeZone();
const dirs: string[] = [];

function restoreTZ(): void {
  if (originalTZ === undefined) delete process.env.TZ;
  else process.env.TZ = originalTZ;
}

afterEach(restoreTZ);
after(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-zone-'));
  dirs.push(dir);
  return dir;
}

/** A keeper over a fresh file, with a Mac whose zone the test moves. */
async function keeper(dir?: string) {
  const file = join(dir ?? (await tempDir()), 'timezone.json');
  const mac = { zone: 'Europe/Copenhagen' as string | null };
  const make = () => new TimeZoneKeeper(file, async () => mac.zone);
  return { file, mac, make, saved: async () => JSON.parse(await readFile(file, 'utf8')) };
}

/** 12:00 UTC, as a local hour: proof the process itself counts in the zone. */
const localHourAtNoonUTC = () => new Date('2026-10-14T12:00:00Z').getHours();

test('only named zones are accepted', () => {
  for (const zone of ['Europe/Copenhagen', 'America/Argentina/Buenos_Aires', 'UTC', 'Etc/GMT+2']) assert.equal(validZone(zone), zone);
  for (const zone of ['+02:00', 'Not/A_Zone', '', '../etc/passwd', 7, null, undefined]) assert.equal(validZone(zone), null, String(zone));
});

test("the Mac's zone is read from the link macOS moves, not from Node", async () => {
  const dir = await tempDir();
  const link = (name: string, target: string) => symlink(target, join(dir, name)).then(() => join(dir, name));
  assert.equal(await readSystemZone(await link('mac', '/var/db/timezone/zoneinfo/America/New_York')), 'America/New_York');
  assert.equal(await readSystemZone(await link('linux', '../usr/share/zoneinfo/posix/Asia/Tokyo')), 'Asia/Tokyo');
  assert.equal(await readSystemZone(await link('junk', '/var/db/timezone/zoneinfo/Not/A_Zone')), null);
  await writeFile(join(dir, 'copied'), 'TZif');
  assert.equal(await readSystemZone(join(dir, 'copied')), null, 'a copied file rather than a link');
  assert.equal(await readSystemZone(join(dir, 'missing')), null);
});

test('a store never told a zone keeps the one Node started in, and writes nothing', async () => {
  const k = await keeper();
  const zone = k.make();
  await zone.start();
  assert.equal(zone.current, startedIn);
  await assert.rejects(readFile(k.file), { code: 'ENOENT' });
});

test("a browser's report moves the dashboard, the process's clock and the file", async () => {
  const k = await keeper();
  const zone = k.make();
  await zone.start();
  assert.equal(await zone.report('America/New_York'), true);
  assert.equal(zone.current, 'America/New_York');
  assert.equal(localHourAtNoonUTC(), 8);
  assert.deepEqual(await k.saved(), { timeZone: 'America/New_York', systemTimeZone: 'Europe/Copenhagen' });
  assert.equal(await zone.report('America/New_York'), false, 'the same zone again changes nothing');
});

test("a Mac mini at home keeps a browser's zone across restarts and ticks", async () => {
  const k = await keeper();
  const first = k.make();
  await first.start();
  await first.report('America/New_York');

  const second = k.make();
  await second.start();
  assert.equal(second.current, 'America/New_York');
  assert.equal(await second.checkSystem(), false, 'the Mac has not moved');
  assert.equal(second.current, 'America/New_York');
});

test('a Mac that moves while the dashboard runs takes the dashboard with it', async () => {
  const k = await keeper();
  const zone = k.make();
  await zone.start();
  await zone.report('America/New_York');
  k.mac.zone = 'Asia/Tokyo';
  assert.equal(await zone.checkSystem(), true);
  assert.equal(zone.current, 'Asia/Tokyo');
  assert.equal(localHourAtNoonUTC(), 21);
  assert.deepEqual(await k.saved(), { timeZone: 'Asia/Tokyo', systemTimeZone: 'Asia/Tokyo' });

  // And a browser after that wins again: whichever moved last.
  await zone.report('America/New_York');
  assert.equal(await zone.checkSystem(), false);
  assert.equal(zone.current, 'America/New_York');
});

test('a Mac that moved while the dashboard was off takes it at the next start', async () => {
  const k = await keeper();
  const first = k.make();
  await first.start();
  await first.report('America/New_York');

  k.mac.zone = 'Asia/Tokyo';
  assert.deepEqual(await startingZone(k.file, 'Asia/Tokyo'), { timeZone: 'Asia/Tokyo', moved: true });
  const second = k.make();
  await second.start();
  assert.equal(second.current, 'Asia/Tokyo');
  assert.equal((await k.saved()).timeZone, 'Asia/Tokyo');
});

test("a Mac that moves to the dashboard's zone only notes where it is", async () => {
  const k = await keeper();
  const zone = k.make();
  await zone.start();
  await zone.report('America/New_York');
  k.mac.zone = 'America/New_York';
  assert.equal(await zone.checkSystem(), false);
  assert.deepEqual(await k.saved(), { timeZone: 'America/New_York', systemTimeZone: 'America/New_York' });
});

test("a Mac whose zone can't be read is simply not followed", async () => {
  const k = await keeper();
  k.mac.zone = null;
  const zone = k.make();
  await zone.start();
  await zone.report('America/New_York');
  assert.equal(await zone.checkSystem(), false);
  assert.deepEqual(await k.saved(), { timeZone: 'America/New_York', systemTimeZone: null });
});

test('a broken or hand-edited file counts as no zone at all', async () => {
  for (const text of ['{', '{"timeZone": "Mars/Olympus_Mons"}', '[]', 'null']) {
    const k = await keeper();
    await writeFile(k.file, text);
    const zone = k.make();
    await zone.start();
    assert.equal(zone.current, startedIn, text);
  }
});

/* ---------- the endpoint ---------- */

let dataDir: string;
let server: StartedServer | null = null;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'daily-focus-server-zone-'));
});

after(async () => {
  await server?.close();
  await rm(dataDir, { recursive: true, force: true });
  restoreTZ();
});

const post = (url: string, body: unknown) =>
  fetch(`${url}/api/timezone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** The clock time of `iso` in `timeZone`, as "07:00". */
const clockIn = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

test('the page reports its zone, the morning clock follows, and a restart keeps it', async () => {
  const env = {
    DAILY_FOCUS_DATA: dataDir,
    DAILY_FOCUS_PORT: '0',
    DAILY_FOCUS_HOST: '127.0.0.1',
    DAILY_FOCUS_GITHUB: 'off',
    DAILY_FOCUS_CALENDAR: 'off',
    DAILY_FOCUS_JIRA: 'off',
    DAILY_FOCUS_AGENT: 'codex',
    DAILY_FOCUS_AGENT_DAYS: '0-6',
    DAILY_FOCUS_AGENT_BIN: '/usr/bin/false',
  };
  // A brief, and a run that started just now: today's in every zone, so the
  // next run is tomorrow at seven and nothing starts.
  const now = new Date().toISOString();
  await writeFile(join(dataDir, 'items.json'), '{}');
  await writeFile(
    join(dataDir, 'agent.jsonl'),
    `${JSON.stringify({ event: 'started', run: 'run-0', cli: 'codex', trigger: 'schedule', at: now })}\n` +
      `${JSON.stringify({ event: 'finished', run: 'run-0', sessionId: null, report: '', messages: [], at: now })}\n`,
  );
  const options = { readSystemZone: async () => 'Europe/Copenhagen' };
  server = await startServer(env, options);

  for (const timeZone of ['+02:00', 'Not/A_Zone', undefined]) {
    const res = await post(server.url, { timeZone });
    assert.equal(res.status, 400, String(timeZone));
  }

  const res = await post(server.url, { timeZone: 'America/New_York' });
  assert.equal(res.status, 200);
  const moved = (await res.json()) as { timeZone: string; agentRun: { schedule: { nextRunAt: string }; runs: unknown[] } };
  assert.equal(moved.timeZone, 'America/New_York');
  assert.equal(clockIn(moved.agentRun.schedule.nextRunAt, 'America/New_York'), '07:00', 'seven in New York, straight away');
  assert.equal(moved.agentRun.runs.length, 1, 'nothing started');

  await server.close();
  server = await startServer(env, options);
  const state = (await (await fetch(`${server.url}/api/state`)).json()) as { timeZone: string };
  assert.equal(state.timeZone, 'America/New_York');
});
