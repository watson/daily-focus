/**
 * A Codex run's subagents, read from Codex's own session files.
 *
 * `codex exec --json` says next to nothing when the agent hands part of the
 * work to a subagent: of the whole exchange, only its waiting comes through,
 * and that without a name. Codex does write every thread down as it goes, one
 * JSON line per event, in `$CODEX_HOME/sessions/YYYY/MM/DD/`, in a file named
 * after the thread's id. The run's own file records each subagent it started
 * and how it ended; each subagent's file, every call the subagent made. So the
 * runner reads them while a run goes, and this is the reading.
 *
 * Only reading: the files are Codex's, and their format is not documented. A
 * line that doesn't read the way it did is skipped, a file that can't be found
 * is looked for again next time, and a run whose files can't be read at all
 * still shows its wait for its subagents, as the stream has it. Read against
 * Codex 0.162.1.
 */

import { open, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { compactArgs, connectorLabel, HANDOFF, shorten, unwrapShell, WAIT, type ParsedStep } from './assistant.ts';

/** Where Codex keeps its files: `CODEX_HOME`, as Codex itself reads it, or `~/.codex`. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME?.trim() || join(homedir(), '.codex');
}

/**
 * Something a thread's file added since the last read: a step, or something a
 * subagent said. `by` is the subagent whose it was, by thread id, or null for
 * the run's own thread.
 */
export type ThreadNews = { by: string | null; step: ParsedStep } | { by: string; message: string };

interface Thread {
  id: string;
  /** The run's own thread, whose calls come through the stream already: only its subagents are read from it. */
  root: boolean;
  path: string | null;
  /** How far the file has been read, in bytes, and the start of a line not yet whole. */
  offset: number;
  partial: Buffer;
}

const DAY_MS = 24 * 60 * 60_000;

/** The most read from one file at a time, so a long session's file is caught up with over a few reads. */
const CHUNK = 4 * 1024 * 1024;

export class CodexSessions {
  private readonly threads = new Map<string, Thread>();
  private readonly since: Date;
  private readonly home: string;

  /** `threadId` is the run's, as the stream's `thread.started` gives it; `since`, when the run started. */
  constructor(threadId: string, since: Date, home: string = codexHome()) {
    this.since = since;
    this.home = home;
    this.threads.set(threadId, { id: threadId, root: true, path: null, offset: 0, partial: Buffer.alloc(0) });
  }

  /**
   * Whatever the files have added since the last read, oldest first within each
   * thread. A subagent found on the way is read in the same pass.
   */
  async read(now: Date = new Date()): Promise<ThreadNews[]> {
    const news: ThreadNews[] = [];
    // A Map's iteration reaches the entries added while it runs.
    for (const thread of this.threads.values()) {
      thread.path ??= await this.find(thread.id, now);
      if (!thread.path) continue;
      for (const line of await this.tail(thread)) this.take(thread, line, news);
    }
    return news;
  }

  /**
   * The file a thread is written to. Codex files a session under the local date
   * it started, so the days the run spans are searched, a day either side for a
   * clock that disagrees.
   */
  private async find(id: string, now: Date): Promise<string | null> {
    const suffix = `-${id}.jsonl`;
    for (let at = this.since.getTime() - DAY_MS; at <= now.getTime() + DAY_MS; at += DAY_MS) {
      const day = new Date(at);
      const dir = join(
        this.home,
        'sessions',
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, '0'),
        String(day.getDate()).padStart(2, '0'),
      );
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      const name = names.find((candidate) => candidate.endsWith(suffix));
      if (name) return join(dir, name);
    }
    return null;
  }

  /** The whole lines added to a thread's file since the last read. */
  private async tail(thread: Thread): Promise<string[]> {
    let handle;
    try {
      handle = await open(thread.path!, 'r');
    } catch {
      return [];
    }
    try {
      const { size } = await handle.stat();
      if (size <= thread.offset) return [];
      const buffer = Buffer.alloc(Math.min(size - thread.offset, CHUNK));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, thread.offset);
      thread.offset += bytesRead;
      // Split on bytes, so a character cut in two by the chunk is joined before it is decoded.
      const bytes = Buffer.concat([thread.partial, buffer.subarray(0, bytesRead)]);
      const end = bytes.lastIndexOf(0x0a);
      thread.partial = end === -1 ? bytes : bytes.subarray(end + 1);
      return end === -1 ? [] : bytes.subarray(0, end).toString('utf8').split('\n');
    } catch {
      return [];
    } finally {
      await handle.close();
    }
  }

  private take(thread: Thread, line: string, news: ThreadNews[]): void {
    let record: { type?: unknown; payload?: { type?: unknown; item?: RolloutItem } };
    try {
      record = JSON.parse(line);
    } catch {
      return;
    }
    if (record?.type !== 'event_msg' || record.payload?.type !== 'item_completed') return;
    const item = record.payload.item;
    if (typeof item !== 'object' || item === null) return;
    const by = thread.root ? null : thread.id;

    if (item.type === 'SubAgentActivity' && typeof item.agent_thread_id === 'string') {
      const child = item.agent_thread_id;
      if (item.kind === 'started') {
        if (!this.threads.has(child)) {
          this.threads.set(child, { id: child, root: false, path: null, offset: 0, partial: Buffer.alloc(0) });
        }
        news.push({ by, step: { id: child, text: HANDOFF, detail: subagentName(item.agent_path), state: 'running', handoff: true } });
      } else if (item.kind === 'completed') {
        news.push({ by, step: { id: child, state: 'done', final: true } });
      } else if (typeof item.kind === 'string' && /fail|error|abort|interrupt|cancel|kill/i.test(item.kind)) {
        news.push({ by, step: { id: child, state: 'failed', final: true } });
      }
      return;
    }
    if (thread.root) return;

    if (item.type === 'AgentMessage') {
      const text = Array.isArray(item.content)
        ? item.content
            .map((part) => (typeof part?.text === 'string' ? part.text : ''))
            .join('')
            .trim()
        : '';
      if (text) news.push({ by: thread.id, message: text });
      return;
    }
    const step = rolloutStep(item);
    // Ids are the thread's own; two threads could each have an `item_1`.
    if (step) news.push({ by: thread.id, step: { ...step, id: `${thread.id}:${step.id}` } });
  }
}

/** An item as a session file records it once done: the fields of the kinds a step is made from. */
interface RolloutItem {
  type?: string;
  id?: string;
  kind?: string;
  agent_thread_id?: string;
  agent_path?: string;
  content?: { text?: string }[];
  command?: string[] | string;
  exit_code?: number | null;
  status?: string;
  server?: string;
  tool?: string;
  appName?: string;
  actionName?: string;
  arguments?: unknown;
  error?: unknown;
  query?: string;
  action?: { type?: string; query?: string | null; url?: string | null; pattern?: string | null };
  changes?: Record<string, unknown>;
  path?: string;
}

/** `/root/gmail_threads` as "gmail threads": the task name the agent gave it. */
function subagentName(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const name = path.split('/').filter(Boolean).at(-1);
  return name ? name.replace(/[_-]+/g, ' ') : null;
}

/** A done call in a subagent's file as a step, the way `codexStep` words the stream's. */
function rolloutStep(item: RolloutItem): ParsedStep | null {
  if (typeof item.id !== 'string') return null;
  const failed = item.status === 'failed' || (item.error !== undefined && item.error !== null);
  const state: ParsedStep['state'] = failed ? 'failed' : 'done';
  switch (item.type) {
    case 'CommandExecution': {
      const command = Array.isArray(item.command)
        ? item.command.length === 3 && /^-l?c$/.test(item.command[1] ?? '')
          ? item.command[2]!
          : item.command.join(' ')
        : unwrapShell(item.command ?? '');
      const exited = typeof item.exit_code === 'number' && item.exit_code !== 0;
      return { id: item.id, text: 'Run a command', detail: shorten(command), state: exited ? 'failed' : state };
    }
    case 'McpToolCall': {
      // Named as the stream names the agent's own calls: Codex's apps by the app's name and the action.
      const app = item.server === 'codex_apps' && typeof item.appName === 'string' && typeof item.actionName === 'string';
      const text = connectorLabel(item.server ?? 'tool', app ? `${item.appName}_${item.actionName}` : (item.tool ?? 'call'));
      return { id: item.id, text, detail: compactArgs(item.arguments), state };
    }
    case 'Extension': {
      if (item.kind !== 'web.search') return null;
      const action = item.action ?? {};
      if (action.type === 'openPage') return { id: item.id, text: 'Open a page', detail: shorten(action.url ?? null), state };
      if (action.type === 'findInPage') return { id: item.id, text: 'Find in a page', detail: shorten(action.pattern ?? null), state };
      return { id: item.id, text: 'Search the web', detail: shorten(action.query || item.query || null), state };
    }
    case 'FileChange':
      return { id: item.id, text: 'Write a file', detail: shorten(Object.keys(item.changes ?? {}).join(', ') || null), state };
    case 'ImageView':
      return { id: item.id, text: 'Look at an image', detail: shorten(item.path?.replace(/^file:\/\//, '') ?? null), state };
    case 'CollabAgentToolCall':
      return item.tool === 'wait' ? { id: item.id, text: WAIT, detail: null, state } : null;
  }
  return null;
}
