/**
 * Reading a Codex run's subagents out of Codex's session files.
 *
 * The rules worth holding: the run's own file gives only its subagents, started
 * and ended, never its own calls, which the stream has; a subagent's file gives
 * its calls and words under its thread id, worded as the stream's are; a
 * subagent's own subagents are found the same way; a line still being written
 * waits for the rest of it; and nothing that can't be read is shown or thrown.
 */

import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { CodexSessions, codexHome, type ThreadNews } from '../src/codexsessions.ts';

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

const ROOT = '0000aaaa-0000-7000-8000-000000000001';
const CHILD = '0000aaaa-0000-7000-8000-000000000002';
const GRANDCHILD = '0000aaaa-0000-7000-8000-000000000003';

/** Codex's home, with its sessions directory for the given local day. */
async function home(day: Date = new Date()): Promise<{ home: string; dir: string }> {
  const home = await mkdtemp(join(tmpdir(), 'daily-focus-codex-'));
  dirs.push(home);
  const dir = join(
    home,
    'sessions',
    String(day.getFullYear()),
    String(day.getMonth() + 1).padStart(2, '0'),
    String(day.getDate()).padStart(2, '0'),
  );
  await mkdir(dir, { recursive: true });
  return { home, dir };
}

const file = (dir: string, id: string) => join(dir, `rollout-2026-10-16T07-00-01-${id}.jsonl`);
const done = (item: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', payload: { type: 'item_completed', item } });
const activity = (kind: string, child: string, path: string) =>
  done({ type: 'SubAgentActivity', id: `sa-${kind}-${child}`, kind, agent_thread_id: child, agent_path: path });
const lines = (...all: string[]) => `${all.join('\n')}\n`;

const steps = (news: ThreadNews[]) => news.map((entry) => ('message' in entry ? { by: entry.by, message: entry.message } : { by: entry.by, ...entry.step }));

test("a run's subagents are its own file's, and their calls and words are theirs", async () => {
  const { home: at, dir } = await home();
  await writeFile(
    file(dir, ROOT),
    lines(
      JSON.stringify({ type: 'session_meta', payload: { id: ROOT } }),
      // The agent's own calls come through the stream, so its file gives none of them.
      done({ type: 'CommandExecution', id: 'exec-root', command: ['/bin/zsh', '-lc', 'cat prompt.md'], status: 'completed', exit_code: 0 }),
      activity('started', CHILD, '/root/inbox_threads'),
    ),
  );
  await writeFile(
    file(dir, CHILD),
    lines(
      JSON.stringify({ type: 'session_meta', payload: { id: CHILD, parent_thread_id: ROOT } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', input: 'text(1)' } }),
      done({ type: 'CommandExecution', id: 'exec-1', command: ['/bin/zsh', '-lc', 'gh pr list --author @me'], status: 'completed', exit_code: 0 }),
      done({ type: 'CommandExecution', id: 'exec-2', command: ['/bin/zsh', '-lc', 'ls /nope'], status: 'completed', exit_code: 1 }),
      done({
        type: 'McpToolCall',
        id: 'exec-3',
        server: 'codex_apps',
        tool: 'gmail.search_emails',
        appName: 'Gmail',
        actionName: 'search_emails',
        arguments: { query: 'newer_than:2d' },
        status: 'completed',
      }),
      done({ type: 'Extension', kind: 'web.search', id: 'exec-4', query: '', action: { type: 'search', query: 'example bank holiday' } }),
      done({ type: 'Extension', kind: 'clock.sleep', id: 'exec-5', durationMs: 1000 }),
      done({ type: 'Reasoning', id: 'rs-1', summary_text: [] }),
      done({ type: 'AgentMessage', id: 'msg-1', content: [{ type: 'Text', text: 'Two threads need an answer.' }], phase: 'final' }),
    ),
  );

  const sessions = new CodexSessions(ROOT, new Date(), at);
  assert.deepEqual(steps(await sessions.read()), [
    { by: null, id: CHILD, text: 'Hand part of it to a subagent', detail: 'inbox threads', state: 'running', handoff: true },
    { by: CHILD, id: `${CHILD}:exec-1`, text: 'Run a command', detail: 'gh pr list --author @me', state: 'done' },
    { by: CHILD, id: `${CHILD}:exec-2`, text: 'Run a command', detail: 'ls /nope', state: 'failed' },
    { by: CHILD, id: `${CHILD}:exec-3`, text: 'Gmail search emails', detail: '{"query":"newer_than:2d"}', state: 'done' },
    { by: CHILD, id: `${CHILD}:exec-4`, text: 'Search the web', detail: 'example bank holiday', state: 'done' },
    { by: CHILD, message: 'Two threads need an answer.' },
  ]);

  // Read again, only what was added since; the subagent's end is its handoff's.
  assert.deepEqual(await sessions.read(), []);
  await appendFile(file(dir, ROOT), lines(activity('completed', CHILD, '/root/inbox_threads')));
  assert.deepEqual(steps(await sessions.read()), [{ by: null, id: CHILD, state: 'done', final: true }]);
});

test("a subagent's own subagents are found the same way, and one that failed says so", async () => {
  const { home: at, dir } = await home();
  await writeFile(file(dir, ROOT), lines(activity('started', CHILD, '/root/calendar')));
  await writeFile(file(dir, CHILD), lines(activity('started', GRANDCHILD, '/root/calendar/family'), activity('errored', GRANDCHILD, '/root/calendar/family')));
  await writeFile(file(dir, GRANDCHILD), lines(done({ type: 'FileChange', id: 'fc', changes: { '/tmp/notes.md': { type: 'add' } }, status: 'completed' })));

  const news = steps(await new CodexSessions(ROOT, new Date(), at).read());
  assert.deepEqual(news, [
    { by: null, id: CHILD, text: 'Hand part of it to a subagent', detail: 'calendar', state: 'running', handoff: true },
    { by: CHILD, id: GRANDCHILD, text: 'Hand part of it to a subagent', detail: 'family', state: 'running', handoff: true },
    { by: CHILD, id: GRANDCHILD, state: 'failed', final: true },
    { by: GRANDCHILD, id: `${GRANDCHILD}:fc`, text: 'Write a file', detail: '/tmp/notes.md', state: 'done' },
  ]);
});

test('a line still being written is read once it is whole, and a file not there yet is looked for again', async () => {
  const { home: at, dir } = await home();
  const sessions = new CodexSessions(ROOT, new Date(), at);
  assert.deepEqual(await sessions.read(), [], 'no file yet');

  const line = activity('started', CHILD, '/root/café_notes');
  const cut = Buffer.from(line).length - 3;
  // Cut through the middle of the line, and of a character in it.
  await writeFile(file(dir, ROOT), Buffer.from(line).subarray(0, Buffer.from(line).indexOf('é') + 1));
  assert.deepEqual(await sessions.read(), []);
  await appendFile(file(dir, ROOT), Buffer.from(line).subarray(Buffer.from(line).indexOf('é') + 1, cut));
  assert.deepEqual(await sessions.read(), []);
  await appendFile(file(dir, ROOT), `${line.slice(-3)}\nnot json\n{"type":"event_msg","payload":{"type":"item_completed","item":null}}\n`);
  assert.deepEqual(steps(await sessions.read()), [
    { by: null, id: CHILD, text: 'Hand part of it to a subagent', detail: 'café notes', state: 'running', handoff: true },
  ]);
});

test("a session filed under yesterday's date is found, and Codex's home is where Codex keeps it", async () => {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60_000);
  const { home: at, dir } = await home(yesterday);
  await writeFile(file(dir, ROOT), lines(activity('started', CHILD, '/root/late')));
  assert.equal((await new CodexSessions(ROOT, now, at).read(now)).length, 1);

  assert.equal(codexHome({ CODEX_HOME: '/opt/codex' }), '/opt/codex');
  assert.match(codexHome({}), /\.codex$/);
});
