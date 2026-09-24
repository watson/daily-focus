/**
 * The on-demand assistant: a coding-agent CLI run headless against one row.
 *
 * Not the morning agent. That one is scheduled and writes the brief; this one
 * answers when the user presses Ask on an item — "is this review right", "draft
 * a reply to this thread" — and it answers in a chat they can continue. The
 * dashboard owns none of the intelligence. It starts the CLI the user already
 * has, hands it the row and the request, streams what comes back, and remembers
 * the session id so the next message resumes the same conversation.
 *
 * Three things to keep apart, each with one owner:
 *
 *  - The conversation lives with the CLI, under its session id. Nothing here
 *    copies it. What is kept is the join — item, session, and the final reply of
 *    each turn — which is all the panel needs to redraw after a reload.
 *  - The running process lives in this process's memory and nowhere else. A
 *    restart loses it, and `start` says so: any turn left running in the log is
 *    closed as aborted rather than shown as a spinner that never stops.
 *  - The log, `assistant.jsonl`, is written by this file alone and never
 *    compacted, like the other two logs in the store.
 *
 * The assistant is deliberately given nothing to edit. Its working directory is
 * an empty directory in the store and its file-editing tools are switched off, so
 * "it only reads and drafts" is a property of the process rather than a line in
 * the prompt. Fixing conflicts or CI is a job for a real coding session.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import type { AssistantAgent, Config } from './config.ts';
import type {
  AssistantItemState,
  AssistantQuickAction,
  AssistantState,
  AssistantTurn,
  BoardRow,
  InProgressTicket,
  ResolvedItem,
  TicketRow,
} from './types.ts';

/**
 * A turn that runs longer than this is killed. Long enough for a thread of forty
 * mails or a CI log; anything longer is the assistant lost in something the
 * panel was never meant for.
 */
const TURN_TIMEOUT_MS = 10 * 60_000;

/** How many turns a row's panel carries. The log keeps all of them. */
const TURNS_SHOWN = 20;

/**
 * The canned requests. Each is a full sentence to the assistant rather than a
 * label the prompt has to expand, so what the button sends is what the panel
 * shows was sent, and a change here needs no matching change in the prompt.
 *
 * Nothing here posts, sends or edits. A reply to a reviewer is handed back as
 * text; a Gmail draft is the one thing created, because a draft is not a send.
 */
export const QUICK_ACTIONS: readonly AssistantQuickAction[] = [
  {
    id: 'assess-review',
    label: 'Assess the review',
    sources: ['github'],
    request:
      'Read every review comment and requested change on this pull request against the diff. ' +
      'For each one say whether it is right, partly right or mistaken, with the evidence, and what I should do about it.',
  },
  {
    id: 'explain-ci',
    label: 'Explain the CI failure',
    sources: ['github'],
    request:
      'Find the failing checks on this pull request and read their logs. Explain what is failing, why, ' +
      'and the smallest change that would fix it. Do not attempt the fix.',
  },
  {
    id: 'summarise-pr',
    label: 'Summarise the change',
    sources: ['github'],
    request:
      'Summarise what this pull request changes and why, in a form I could paste as its description, ' +
      'and flag anything a reviewer is likely to push back on.',
  },
  {
    id: 'reply-reviewer',
    label: 'Draft replies to reviewers',
    sources: ['github'],
    request:
      'Draft a reply to each open review comment on this pull request, in my voice, agreeing where the ' +
      'reviewer is right and explaining where they are not. Give me the text to post. Do not post it.',
  },
  {
    id: 'draft-reply',
    label: 'Draft a reply',
    sources: ['email'],
    request:
      'Read the whole thread and draft a reply from me, in my voice, that answers what was asked. ' +
      'Create it as a Gmail draft on this thread so I can open it there. Never send it. ' +
      'If you cannot create drafts, give me the text instead and say so.',
  },
  {
    id: 'summarise-thread',
    label: 'Summarise the thread',
    sources: ['email'],
    request: 'Read the whole thread and summarise it: who wants what, what has been decided, and what is still open.',
  },
  {
    id: 'what-they-need',
    label: 'What do they need from me?',
    sources: ['email', 'slack', 'messages'],
    request:
      'Read this and tell me exactly what is being asked of me, by whom, by when, and what the smallest ' +
      'adequate response would be.',
  },
  {
    id: 'summarise-ticket',
    label: 'Summarise the ticket',
    sources: ['jira'],
    request:
      'Read this ticket, its comments and anything it links to, and summarise where it stands: ' +
      'what is done, what is left, and what is blocking it.',
  },
  {
    id: 'status-comment',
    label: 'Draft a status comment',
    sources: ['jira'],
    request:
      'Read this ticket and its linked pull requests, and draft a short status comment from me for the ' +
      'ticket. Give me the text to post. Do not post it.',
  },
  {
    id: 'next-steps',
    label: 'Break it into next steps',
    sources: null,
    request:
      'Read whatever this item points at and turn it into three to five concrete next steps I could ' +
      'start on today, smallest first.',
  },
];

/** What the server knows about the row when the user presses Ask. */
export interface AskContext {
  item?: ResolvedItem;
  pull?: BoardRow;
  ticket?: TicketRow | InProgressTicket;
}

/** What a caller asks for: a quick action by id, typed text, or both. */
export interface AskRequest {
  itemId: string;
  action?: string;
  text?: string;
}

/* ---------- the log ---------- */

/** One line in assistant.jsonl. */
type LogRecord =
  | {
      event: 'started';
      turn: string;
      item: string;
      agent: AssistantAgent;
      request: string;
      action: string | null;
      at: string;
    }
  | { event: 'finished'; turn: string; sessionId: string | null; reply: string; at: string }
  | { event: 'failed'; turn: string; sessionId: string | null; error: string; reply: string; at: string }
  | { event: 'aborted'; turn: string; sessionId: string | null; reason: string; reply: string; at: string };

/**
 * Fold the log into turns. Forgiving line by line, as the action log is: one
 * broken line must not take the panel with it.
 */
export function foldAssistantLog(text: string): Map<string, AssistantTurn> {
  const turns = new Map<string, AssistantTurn>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: LogRecord;
    try {
      record = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null || typeof record.turn !== 'string') continue;

    if (record.event === 'started') {
      if (typeof record.item !== 'string' || typeof record.request !== 'string') continue;
      turns.set(record.turn, {
        id: record.turn,
        itemId: record.item,
        agent: record.agent,
        sessionId: null,
        request: record.request,
        action: typeof record.action === 'string' ? record.action : null,
        startedAt: record.at,
        endedAt: null,
        status: 'running',
        reply: '',
        error: null,
      });
      continue;
    }

    const turn = turns.get(record.turn);
    if (!turn) continue;
    turn.sessionId = typeof record.sessionId === 'string' ? record.sessionId : turn.sessionId;
    turn.reply = typeof record.reply === 'string' ? record.reply : turn.reply;
    turn.endedAt = record.at;
    if (record.event === 'finished') {
      turn.status = 'done';
    } else if (record.event === 'failed') {
      turn.status = 'failed';
      turn.error = record.error;
    } else if (record.event === 'aborted') {
      turn.status = 'aborted';
      turn.error = record.reason;
    }
  }
  return turns;
}

/* ---------- the CLIs ---------- */

/** What one line of a CLI's output meant, reduced to what the panel needs. */
export interface ParsedEvent {
  sessionId?: string;
  /** A piece of assistant text: appended to the reply so far. */
  text?: string;
  /** The turn is over. `reply` replaces whatever was accumulated when given. */
  done?: { ok: boolean; reply?: string; error?: string };
}

export interface SpawnOptions {
  prompt: string;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  tools: readonly string[];
}

/**
 * One per CLI: how to ask it, and how to read what it says. Kept to the two
 * things that genuinely differ so a third CLI is a third object here and
 * nothing else.
 */
export interface Adapter {
  args(opts: SpawnOptions): string[];
  parse(line: string): ParsedEvent | null;
}

function parseLine(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Claude Code in print mode, streaming JSON.
 *
 * `--permission-prompts none` with `--permission-mode dontAsk` means anything
 * that would have asked is denied instead, and only `--allowedTools` gets
 * through. The editing tools are denied by name on top, so no allowlist entry
 * can let them back in by accident.
 */
export const claudeAdapter: Adapter = {
  args({ prompt, sessionId, model, effort, tools }) {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
      '--disallowedTools',
      'Edit',
      'Write',
      'NotebookEdit',
    ];
    if (tools.length > 0) args.push('--allowedTools', ...tools);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (sessionId) args.push('--resume', sessionId);
    args.push(prompt);
    return args;
  },
  parse(line) {
    const event = parseLine(line);
    if (!event) return null;
    const type = event.type;
    if (type === 'system' && typeof event.session_id === 'string') {
      return { sessionId: event.session_id };
    }
    if (type === 'assistant') {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as { type?: string; text?: string }[]) : [];
      const text = content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text!)
        .join('\n\n');
      return text ? { text } : null;
    }
    if (type === 'result') {
      const ok = event.is_error !== true && event.subtype === 'success';
      const reply = typeof event.result === 'string' ? event.result : undefined;
      const parsed: ParsedEvent = { done: ok ? { ok, reply } : { ok, error: reply ?? String(event.subtype ?? 'failed') } };
      if (typeof event.session_id === 'string') parsed.sessionId = event.session_id;
      return parsed;
    }
    return null;
  },
};

/**
 * Codex in exec mode, streaming JSON. Its sandbox is the whole permission
 * policy; there is no per-tool list to hand it. The workspace-write sandbox
 * rather than read-only, because read-only also cuts the network and takes
 * `gh` with it — and the workspace it may write to is the empty scratch
 * directory the assistant runs in, so nothing real becomes writable.
 */
export const codexAdapter: Adapter = {
  args({ prompt, sessionId, model, effort }) {
    const args = ['exec'];
    if (sessionId) args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    // Config overrides are parsed as TOML, so a string has to carry its quotes.
    // As overrides rather than `--sandbox`, which the resume form doesn't take.
    args.push('-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true');
    if (model) args.push('-c', `model=${JSON.stringify(model)}`);
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (sessionId) args.push(sessionId);
    args.push(prompt);
    return args;
  },
  parse(line) {
    const event = parseLine(line);
    if (!event) return null;
    const type = event.type;
    if (type === 'thread.started' && typeof event.thread_id === 'string') {
      return { sessionId: event.thread_id };
    }
    if (type === 'item.completed') {
      const item = event.item as { type?: string; text?: string } | undefined;
      if (item?.type === 'agent_message' && typeof item.text === 'string') return { text: item.text };
      return null;
    }
    if (type === 'turn.completed') return { done: { ok: true } };
    if (type === 'turn.failed' || type === 'error') {
      const error = event.error as { message?: string } | undefined;
      const message = typeof event.message === 'string' ? event.message : error?.message;
      return { done: { ok: false, error: message ?? String(type) } };
    }
    return null;
  },
};

export const ADAPTERS: Readonly<Record<AssistantAgent, Adapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/* ---------- the prompt ---------- */

/**
 * The first message of a session: the instructions, the row, and the request.
 * Later messages resume the session and carry only the request, since the CLI
 * still has the rest.
 *
 * The instructions are inlined rather than passed as a system prompt because the
 * two CLIs take one differently, and one shape that works for both is worth more
 * than the distinction.
 */
export function composePrompt(instructions: string, context: AskContext, request: string, profile: string): string {
  const now = new Date();
  const facts: string[] = [`- Profile: ${profile}`, `- Today: ${now.toISOString().slice(0, 10)}`];
  const parts = [instructions.trim(), '', '## Context', '', ...facts, ''];
  if (context.item) parts.push('### The item', '', '```json', JSON.stringify(context.item, null, 2), '```', '');
  if (context.pull) parts.push('### The pull request, as the board last saw it', '', '```json', JSON.stringify(context.pull, null, 2), '```', '');
  if (context.ticket) parts.push('### The ticket, as the board last saw it', '', '```json', JSON.stringify(context.ticket, null, 2), '```', '');
  parts.push('## Request', '', request.trim());
  return parts.join('\n');
}

/* ---------- the runner ---------- */

interface RunningTurn {
  turn: AssistantTurn;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  /** Set by `stop`, so the exit handler can tell a kill from a crash. */
  abortReason: string | null;
}

export interface AssistantHooks {
  /** Something changed that a tab should see. */
  onChange: () => void;
}

export class Assistant {
  private readonly turns = new Map<string, AssistantTurn>();
  private readonly running = new Map<string, RunningTurn>();
  private loaded = false;
  private readonly config: Config;
  private readonly hooks: AssistantHooks;
  private readonly spawnFn: typeof spawn;

  constructor(config: Config, hooks: AssistantHooks, spawnFn: typeof spawn = spawn) {
    this.config = config;
    this.hooks = hooks;
    // Swapped in by tests, which run a script in place of the CLI.
    this.spawnFn = spawnFn;
  }

  get enabled(): boolean {
    return this.config.assistant.agent !== null;
  }

  /**
   * Read the log, and close whatever was left running when the last process
   * died. Cheap when the assistant is off: the log is read only if it exists.
   */
  async start(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text = '';
    try {
      text = await readFile(this.config.assistantLogFile, 'utf8');
    } catch {
      return;
    }
    for (const [id, turn] of foldAssistantLog(text)) this.turns.set(id, turn);
    for (const turn of this.turns.values()) {
      if (turn.status !== 'running') continue;
      turn.status = 'aborted';
      turn.error = 'the dashboard restarted while this was running';
      turn.endedAt = new Date().toISOString();
      await this.append({
        event: 'aborted',
        turn: turn.id,
        sessionId: turn.sessionId,
        reason: turn.error,
        reply: turn.reply,
        at: turn.endedAt,
      });
    }
  }

  view(): AssistantState {
    const items: Record<string, AssistantItemState> = {};
    for (const turn of this.turns.values()) {
      const entry = (items[turn.itemId] ??= { running: false, sessionId: null, turns: [] });
      entry.turns.push(turn);
      if (turn.status === 'running') entry.running = true;
      // The newest session that has an id — a failed first turn may never have got
      // one — and only from the CLI now configured: a Claude session id means
      // nothing to Codex, and switching the setting must start afresh, not fail.
      if (turn.sessionId && turn.agent === this.config.assistant.agent) entry.sessionId = turn.sessionId;
    }
    for (const entry of Object.values(items)) {
      entry.turns.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
      entry.turns = entry.turns.slice(-TURNS_SHOWN);
    }
    return {
      enabled: this.enabled,
      agent: this.config.assistant.agent,
      quickActions: [...QUICK_ACTIONS],
      items,
    };
  }

  /** The request text an ask resolves to, or null when there is nothing to send. */
  static requestFor(ask: AskRequest): { request: string; action: string | null } | null {
    const action = ask.action ? QUICK_ACTIONS.find((candidate) => candidate.id === ask.action) : undefined;
    if (ask.action && !action) return null;
    const typed = (ask.text ?? '').trim();
    if (!action && typed === '') return null;
    const request = action ? (typed ? `${action.request}\n\n${typed}` : action.request) : typed;
    return { request, action: action?.id ?? null };
  }

  /**
   * Start a turn. Returns once the process is running, not once it has answered;
   * the answer arrives through `onChange` and the next state.
   */
  async ask(ask: AskRequest, context: AskContext): Promise<AssistantTurn> {
    const agent = this.config.assistant.agent;
    if (!agent) throw new Error('the assistant is off; set DAILY_FOCUS_ASSISTANT to claude or codex');
    if (this.running.has(ask.itemId)) throw new Error('the assistant is already working on this item');
    const resolved = Assistant.requestFor(ask);
    if (!resolved) throw new Error('nothing to ask: give a quick action or some text');

    await this.start();
    const previous = this.view().items[ask.itemId]?.sessionId ?? null;
    const turn: AssistantTurn = {
      id: randomUUID(),
      itemId: ask.itemId,
      agent,
      // Null until the CLI says: a resumed session that fails must not be
      // recorded as if this CLI had owned it.
      sessionId: null,
      request: resolved.request,
      action: resolved.action,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      reply: '',
      error: null,
    };
    this.turns.set(turn.id, turn);
    await this.append({
      event: 'started',
      turn: turn.id,
      item: turn.itemId,
      agent,
      request: turn.request,
      action: turn.action,
      at: turn.startedAt,
    });

    const prompt = previous
      ? resolved.request
      : composePrompt(await this.instructions(), context, resolved.request, this.config.profile);

    await mkdir(this.config.assistantDir, { recursive: true });
    const adapter = ADAPTERS[agent];
    const args = adapter.args({
      prompt,
      sessionId: previous,
      model: this.config.assistant.model,
      effort: this.config.assistant.effort,
      tools: this.config.assistant.tools,
    });

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.config.assistant.binPath, args, {
        cwd: this.config.assistantDir,
        // Stdin closed: both CLIs wait on it otherwise, one of them for three seconds.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      await this.finish(turn, { ok: false, error: this.spawnError(err) });
      return turn;
    }

    const timer = setTimeout(() => this.stop(turn.itemId, 'gave up after ten minutes'), TURN_TIMEOUT_MS);
    timer.unref();
    const run: RunningTurn = { turn, child, timer, abortReason: null };
    this.running.set(turn.itemId, run);
    this.hooks.onChange();

    let done: ParsedEvent['done'] | undefined;
    const stderr: string[] = [];
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr.push(chunk.toString('utf8'));
      if (stderr.length > 50) stderr.shift();
    });
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const event = adapter.parse(line);
        if (!event) return;
        if (event.sessionId) turn.sessionId = event.sessionId;
        if (event.text) {
          turn.reply = turn.reply ? `${turn.reply}\n\n${event.text}` : event.text;
          this.hooks.onChange();
        }
        if (event.done) done = event.done;
      });
    }
    child.on('error', (err) => {
      done = { ok: false, error: this.spawnError(err) };
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      this.running.delete(turn.itemId);
      const outcome: ParsedEvent['done'] = run.abortReason
        ? { ok: false, error: run.abortReason }
        : (done ?? {
            ok: false,
            error: `${agent} exited with code ${code}${stderr.length ? `: ${stderr.join('').trim().split('\n').slice(-3).join(' ')}` : ''}`,
          });
      void this.finish(turn, outcome, run.abortReason !== null);
    });

    return turn;
  }

  /** Kill the turn running on an item, if any. */
  async stop(itemId: string, reason = 'stopped'): Promise<boolean> {
    const run = this.running.get(itemId);
    if (!run) return false;
    run.abortReason = reason;
    run.child.kill('SIGTERM');
    return true;
  }

  /** Kill everything, for shutdown. The exit handlers write the aborted lines. */
  async close(): Promise<void> {
    for (const itemId of [...this.running.keys()]) await this.stop(itemId, 'the dashboard shut down');
  }

  private async finish(turn: AssistantTurn, outcome: NonNullable<ParsedEvent['done']>, aborted = false): Promise<void> {
    const at = new Date().toISOString();
    // The reply is the whole record. Nothing the assistant says is copied onto
    // the item: the chat is where the user asked, and the chat is where the
    // answer stays.
    const reply = outcome.reply ?? turn.reply;
    turn.reply = reply;
    turn.endedAt = at;
    if (outcome.ok) {
      turn.status = 'done';
      await this.append({ event: 'finished', turn: turn.id, sessionId: turn.sessionId, reply, at });
    } else if (aborted) {
      turn.status = 'aborted';
      turn.error = outcome.error ?? 'stopped';
      await this.append({ event: 'aborted', turn: turn.id, sessionId: turn.sessionId, reason: turn.error, reply, at });
    } else {
      turn.status = 'failed';
      turn.error = outcome.error ?? 'failed';
      await this.append({ event: 'failed', turn: turn.id, sessionId: turn.sessionId, error: turn.error, reply, at });
    }
    this.hooks.onChange();
  }

  private spawnError(err: unknown): string {
    const code = (err as NodeJS.ErrnoException).code;
    const bin = this.config.assistant.binPath;
    if (code === 'ENOENT') return `could not find ${bin}; install it or set DAILY_FOCUS_ASSISTANT_BIN to its path`;
    return `could not run ${bin}: ${err instanceof Error ? err.message : String(err)}`;
  }

  /** The store's copy, or the repo's before `npm run init` has linked it. */
  private async instructions(): Promise<string> {
    for (const path of [this.config.assistantPromptFile, this.config.assistantPromptSource]) {
      try {
        return await readFile(path, 'utf8');
      } catch {
        // Try the next.
      }
    }
    return 'You are helping with one item from a personal dashboard. Read only; never send, post or edit anything.';
  }

  /**
   * The log records what happened; the turn in memory is updated by the caller
   * first. Only this process writes the file, so the memory never has to be
   * re-read from it.
   */
  private async append(record: LogRecord): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await appendFile(this.config.assistantLogFile, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
