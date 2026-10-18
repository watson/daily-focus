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
 *    copies it. What is kept is the join — item, session, the final reply of
 *    each turn, and a line for each call it made on the way — which is all the
 *    panel needs to redraw after a reload.
 *  - The running process lives in this process's memory and nowhere else. A
 *    restart loses it, and `start` says so: any turn left running in the log is
 *    closed as aborted rather than shown as a spinner that never stops.
 *  - The log, `assistant.jsonl`, is written by this file alone and never
 *    compacted, like the other two logs in the store.
 *
 * The assistant is deliberately given nothing to edit. Its working directory is
 * an empty directory in the store, and fixing conflicts or CI is a job for a real
 * coding session. How much of "it only reads and drafts" the process enforces
 * depends on the CLI, and the rest is the prompt:
 *
 *  - Claude Code gets only the tools in its list, with the editing tools denied
 *    whatever the list says. The default list includes the whole Gmail connector
 *    and the `gh` and `acli` CLIs, all of which can write; narrowing it is left
 *    to the user, and the README shows how.
 *  - Codex refuses every connector write except a Gmail draft (see `codex.ts`),
 *    and computer use unless the user turns it on. Its shell follows the user's
 *    own Codex config, so `gh` keeps working, and so can write.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

import { CodexGate, CONNECTOR_POLICY, computerUseOff, configArgs, GMAIL_DRAFTS } from './codex.ts';
import type { AssistantAgent, Config } from './config.ts';
import { cliEnvironment } from './env.ts';
import { launchFor, stopProcess } from './launch.ts';
import type { ExecFile } from './shellpath.ts';
import type {
  AssistantItemState,
  AssistantQuickAction,
  AssistantState,
  AssistantStep,
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

/**
 * Why a turn was cut short by the dashboard going away rather than by anyone's
 * choice. Asking ahead tries such a turn again; see `autoask.ts`.
 */
export const RESTARTED = 'the dashboard restarted while this was running';
export const SHUT_DOWN = 'the dashboard shut down';

/** How many turns a row's panel carries. The log keeps all of them. */
const TURNS_SHOWN = 20;

/**
 * How many steps a turn keeps, the newest. A turn that calls a hundred tools
 * has a trail nobody reads to the start of, and every tab is sent all of it.
 */
const STEPS_KEPT = 100;

/** How much of a command, query or argument list a step shows. The CLI's own log has the rest. */
const DETAIL_LENGTH = 200;

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
      /** Only on a turn the dashboard started on its own: what it answered. */
      auto?: string;
      at: string;
    }
  | { event: 'finished'; turn: string; sessionId: string | null; reply: string; steps: AssistantStep[]; at: string }
  | { event: 'failed'; turn: string; sessionId: string | null; error: string; reply: string; steps: AssistantStep[]; at: string }
  | { event: 'aborted'; turn: string; sessionId: string | null; reason: string; reply: string; steps: AssistantStep[]; at: string };

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
        auto: typeof record.auto === 'string' ? record.auto : null,
        startedAt: record.at,
        endedAt: null,
        status: 'running',
        reply: '',
        steps: [],
        error: null,
      });
      continue;
    }

    const turn = turns.get(record.turn);
    if (!turn) continue;
    turn.sessionId = typeof record.sessionId === 'string' ? record.sessionId : turn.sessionId;
    turn.reply = typeof record.reply === 'string' ? record.reply : turn.reply;
    turn.steps = readSteps((record as { steps?: unknown }).steps);
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

/** Add a step to a running turn, letting the oldest go past `STEPS_KEPT`. */
function addStep(turn: AssistantTurn, step: AssistantStep): void {
  turn.steps.push(step);
  if (turn.steps.length > STEPS_KEPT) turn.steps.shift();
}

/** The same text but for spacing: how a CLI's final result compares with the message it repeats. */
function sameWords(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/** A logged step list, keeping the steps that still read as steps. Lines from before steps were kept have none. */
function readSteps(value: unknown): AssistantStep[] {
  if (!Array.isArray(value)) return [];
  const steps: AssistantStep[] = [];
  for (const candidate of value as Partial<AssistantStep>[]) {
    if (typeof candidate !== 'object' || candidate === null || typeof candidate.text !== 'string') continue;
    steps.push({
      kind: candidate.kind === 'message' ? 'message' : 'tool',
      text: candidate.text,
      detail: typeof candidate.detail === 'string' ? candidate.detail : null,
      state: candidate.state === 'failed' ? 'failed' : 'done',
    });
  }
  return steps;
}

/* ---------- the CLIs ---------- */

/** What one line of a CLI's output meant, reduced to what the panel needs. */
export interface ParsedEvent {
  sessionId?: string;
  /** Something the assistant said: on the way, or, the last time, the answer. */
  text?: string;
  /** Tool calls the line starts or settles. When a line has text too, the text came first. */
  steps?: ParsedStep[];
  /**
   * Set when the line is a subagent's rather than the agent's own: the id of the
   * call that handed it the work. What it says is then not the answer.
   */
  by?: string;
  /**
   * The turn is over. `reply` replaces whatever was accumulated when given. A
   * failure the dashboard recognises carries its `cause`, and its `error` is then
   * the plain sentence `explainFailure` made of what the CLI said.
   */
  done?: { ok: boolean; reply?: string; error?: string; cause?: FailureCause };
}

/**
 * A tool call as one line reports it. The CLI's id for the call ties the line
 * that starts it to the one that says how it went; the second may carry only
 * the outcome, or, for a web search, the query the first did not know yet.
 */
export interface ParsedStep {
  id: string;
  text?: string;
  detail?: string | null;
  state: AssistantStep['state'];
  /** On a call that hands part of the work to a subagent, whose lines name this id in `by`. */
  handoff?: true;
  /**
   * How a subagent's work ended. A handoff waits for this rather than for its
   * call's result, since a subagent started in the background works on after
   * the call has returned.
   */
  final?: true;
}

export interface SpawnOptions {
  prompt: string;
  sessionId: string | null;
  model: string | null;
  effort: string | null;
  tools: readonly string[];
  /**
   * Deny the editing tools by name. True for the assistant, which is given
   * nothing to edit; false for the morning agent, which has to write its brief
   * and is held to that one file by `tools` instead. Claude Code only: Codex's
   * sandbox confines its edits to the working directory.
   */
  denyEdits: boolean;
  /**
   * May create and revise Gmail drafts without asking. Codex only, where every
   * other connector write is refused; Claude Code's tool list decides for it.
   */
  drafts: boolean;
  /**
   * More Codex config, in its `-c key=value` form: what `computerUseOff` found to
   * switch off. Ignored by Claude Code.
   */
  codexConfig: readonly string[];
  /**
   * The shape the final answer must take, for a turn whose answer the dashboard
   * reads rather than shows: setup's proposals (see `onboarding.ts`). Claude Code
   * takes the schema itself, Codex a file holding it; both then end on the JSON
   * alone, as the reply. Unset for the assistant and the morning agent.
   */
  schema?: { json: string; file: string } | null;
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

/**
 * Why a turn failed, for the few failures someone can act on without reading
 * the CLI's own words: the service is busy, which passes; the account can't use
 * the model asked for; the plan doesn't include the CLI at all.
 */
export type FailureCause = 'busy' | 'model' | 'plan';

/**
 * A failure the dashboard recognises, as a plain sentence and its cause, or
 * null for any other, which is shown as the CLI said it. Matched on what each
 * CLI says: Claude Code 2.1.300 and Codex 0.162.1, read from the programs and
 * from a session asked for a model nobody can use. Codex's own message is
 * often a JSON error object inside the event; `codexAdapter` unwraps it first.
 */
export function explainFailure(cli: AssistantAgent, error: string): { cause: FailureCause; message: string } | null {
  if (cli === 'claude') {
    // "Repeated 529 Overloaded errors", "Opus is experiencing high load, please use /model to switch to Sonnet"
    if (/\b529\b|overloaded|experiencing high load/i.test(error)) return { cause: 'busy', message: 'Claude is busy right now' };
    // "There's an issue with the selected model (x). It may not exist or you may not have access to it."
    const model = /issue with the selected model \((.+?)\)/.exec(error)?.[1];
    if (model) return { cause: 'model', message: `your Claude account can't use the model “${model}”` };
    return null;
  }
  // From the server: "The 'x' model is not supported when using Codex with a ChatGPT account."
  const model = /The '(.+?)' model is not supported when using Codex/.exec(error)?.[1];
  if (model) return { cause: 'model', message: `your ChatGPT plan or workspace doesn't include the model “${model}”` };
  // Free and Go: "To use Codex with your ChatGPT plan, upgrade to Plus: …"
  if (/To use Codex with your ChatGPT plan/.test(error)) {
    return { cause: 'plan', message: "your ChatGPT plan doesn't include the Codex CLI, which needs Plus or higher" };
  }
  // "Selected model is at capacity. Please try a different model.", "We're currently experiencing high demand, …"
  if (/at capacity|high demand|server_overloaded/i.test(error)) return { cause: 'busy', message: 'Codex is busy right now' };
  return null;
}

/** A failed turn's `done`: plain when `explainFailure` knows the failure, as the CLI said it when not. */
function failed(cli: AssistantAgent, error: string): NonNullable<ParsedEvent['done']> {
  const explained = explainFailure(cli, error);
  return explained ? { ok: false, error: explained.message, cause: explained.cause } : { ok: false, error };
}

/** The message inside a Codex error that carries the server's JSON error object as its message, or the message as it was. */
function unwrapCodexError(message: string): string {
  try {
    const inner = (JSON.parse(message) as { error?: { message?: unknown } } | null)?.error?.message;
    return typeof inner === 'string' && inner.trim() ? inner : message;
  } catch {
    return message;
  }
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
 * through. For the assistant the editing tools are denied by name on top, so no
 * allowlist entry can let them back in by accident.
 */
export const claudeAdapter: Adapter = {
  args({ prompt, sessionId, model, effort, tools, denyEdits, schema }) {
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'dontAsk',
      '--permission-prompts',
      'none',
    ];
    if (denyEdits) args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit');
    if (tools.length > 0) args.push('--allowedTools', ...tools);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (schema) args.push('--json-schema', schema.json);
    if (sessionId) args.push('--resume', sessionId);
    // End the variadic permission options before the positional prompt.
    args.push('--', prompt);
    return args;
  },
  parse(line) {
    const event = parseLine(line);
    if (!event) return null;
    const type = event.type;
    // How a subagent's work ended, foreground or background, keyed by the call that started it.
    if (type === 'system' && event.subtype === 'task_notification' && typeof event.tool_use_id === 'string') {
      const step: ParsedStep = { id: event.tool_use_id, state: event.status === 'completed' ? 'done' : 'failed', final: true };
      return { steps: [step] };
    }
    if (type === 'system' && typeof event.session_id === 'string') {
      return { sessionId: event.session_id };
    }
    if (type === 'assistant' || type === 'user') {
      const message = event.message as { content?: unknown } | undefined;
      const content = Array.isArray(message?.content) ? (message!.content as ClaudeBlock[]) : [];
      const parsed: ParsedEvent = {};
      // Only the assistant speaks; a user line is the tools answering it.
      const text =
        type === 'assistant'
          ? content
              .filter((block) => block.type === 'text' && typeof block.text === 'string')
              .map((block) => block.text!)
              .join('\n\n')
          : '';
      if (text) parsed.text = text;
      const steps = content.flatMap((block) => claudeStep(block) ?? []);
      if (steps.length) parsed.steps = steps;
      if (!text && !steps.length) return null;
      if (typeof event.parent_tool_use_id === 'string') parsed.by = event.parent_tool_use_id;
      return parsed;
    }
    if (type === 'result') {
      const ok = event.is_error !== true && event.subtype === 'success';
      const reply = typeof event.result === 'string' ? event.result : undefined;
      const parsed: ParsedEvent = { done: ok ? { ok, reply } : failed('claude', reply ?? String(event.subtype ?? 'failed')) };
      if (typeof event.session_id === 'string') parsed.sessionId = event.session_id;
      return parsed;
    }
    return null;
  },
};

/**
 * Codex in exec mode, streaming JSON. There is no per-tool list to hand it, so
 * the policy is the sandbox plus the connector rules in `codex.ts`. The
 * workspace-write sandbox rather than read-only, because read-only also cuts the
 * network and takes `gh` with it — and the workspace it may write to is the
 * working directory the dashboard gives it. Commands that leave the sandbox, and
 * the approval policy that decides them, are the user's own Codex config's.
 */
export const codexAdapter: Adapter = {
  args({ prompt, sessionId, model, effort, drafts, codexConfig, schema }) {
    const args = ['exec'];
    if (sessionId) args.push('resume');
    args.push('--json', '--skip-git-repo-check');
    if (schema) args.push('--output-schema', schema.file);
    // Config overrides are parsed as TOML, so a string has to carry its quotes.
    // As overrides rather than `--sandbox`, which the resume form doesn't take.
    const config = [
      'sandbox_mode="workspace-write"',
      'sandbox_workspace_write.network_access=true',
      ...CONNECTOR_POLICY,
      ...(drafts ? GMAIL_DRAFTS : []),
      ...codexConfig,
    ];
    if (model) config.push(`model=${JSON.stringify(model)}`);
    if (effort) config.push(`model_reasoning_effort=${JSON.stringify(effort)}`);
    args.push(...configArgs(config));
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
    if (type === 'item.started' || type === 'item.completed') {
      const item = event.item as CodexItem | undefined;
      if (type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return { text: item.text };
      const step = item ? codexStep(item, type === 'item.completed') : null;
      return step ? { steps: [step] } : null;
    }
    if (type === 'turn.completed') return { done: { ok: true } };
    if (type === 'turn.failed' || type === 'error') {
      const error = event.error as { message?: string } | undefined;
      const message = typeof event.message === 'string' ? event.message : error?.message;
      return { done: failed('codex', message ? unwrapCodexError(message) : String(type)) };
    }
    return null;
  },
};

export const ADAPTERS: Readonly<Record<AssistantAgent, Adapter>> = {
  claude: claudeAdapter,
  codex: codexAdapter,
};

/* ---------- steps: what each CLI's tool calls look like on the panel ---------- */

/** A content block in a Claude Code message: text, a tool call, or a tool's answer. */
interface ClaudeBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
}

/**
 * Claude Code's own housekeeping, which says nothing about the item: loading a
 * tool's schema, keeping a to-do list, and handing over a structured answer.
 */
const CLAUDE_QUIET_TOOLS = new Set(['ToolSearch', 'TodoWrite', 'StructuredOutput']);

/** The step that hands part of the work to a subagent, and the one that waits for them, whichever CLI. */
export const HANDOFF = 'Hand part of it to a subagent';
export const WAIT = 'Wait for its subagents';

/**
 * A step for a tool call or a tool's answer. Worded as an instruction, the way
 * Claude Code's own command descriptions are ("View the pull request"), so a
 * step reads the same running and done.
 */
function claudeStep(block: ClaudeBlock): ParsedStep | null {
  if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
    return { id: block.tool_use_id, state: block.is_error === true ? 'failed' : 'done' };
  }
  if (block.type !== 'tool_use' || typeof block.id !== 'string' || typeof block.name !== 'string') return null;
  if (CLAUDE_QUIET_TOOLS.has(block.name)) return null;
  const input = block.input ?? {};
  const said = (key: string): string | null => (typeof input[key] === 'string' && input[key] !== '' ? (input[key] as string) : null);
  const step = (text: string, detail: string | null): ParsedStep => ({ id: block.id!, text, detail: shorten(detail), state: 'running' });
  switch (block.name) {
    case 'Bash':
      return step(said('description') ?? 'Run a command', said('command'));
    case 'WebFetch':
      return step('Fetch a page', said('url'));
    case 'WebSearch':
      return step('Search the web', said('query'));
    case 'Read':
      return step('Read a file', said('file_path'));
    case 'Grep':
      return step('Search files', said('pattern'));
    case 'Glob':
      return step('List files', said('pattern'));
    case 'Task':
    case 'Agent':
      return { ...step(HANDOFF, said('description')), handoff: true };
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(block.name);
  if (mcp) return step(connectorLabel(mcp[1]!, mcp[2]!), compactArgs(input));
  return step(block.name, compactArgs(input));
}

/** An item in Codex's JSON stream: the fields of the kinds a step is made from. */
interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  exit_code?: number | null;
  status?: string;
  server?: string;
  tool?: string;
  arguments?: unknown;
  error?: unknown;
  query?: string;
  action?: { type?: string; query?: string; url?: string; pattern?: string };
}

/**
 * A step for a Codex item, when it is a call to something: a shell command, a
 * connector's tool, a web search. Started, it is running; completed, it says how
 * it went. Reasoning, plans and the messages are not steps.
 */
function codexStep(item: CodexItem, completed: boolean): ParsedStep | null {
  if (typeof item.id !== 'string') return null;
  const failed = item.status === 'failed' || (item.error !== undefined && item.error !== null);
  const state: AssistantStep['state'] = completed ? (failed ? 'failed' : 'done') : 'running';
  if (item.type === 'command_execution') {
    const exited = typeof item.exit_code === 'number' && item.exit_code !== 0;
    return {
      id: item.id,
      text: 'Run a command',
      detail: shorten(unwrapShell(item.command ?? '')),
      state: completed && exited ? 'failed' : state,
    };
  }
  if (item.type === 'mcp_tool_call' && typeof item.server === 'string' && typeof item.tool === 'string') {
    return { id: item.id, text: connectorLabel(item.server, item.tool), detail: compactArgs(item.arguments), state };
  }
  // Of the subagents, the stream says only that it waits for them; `codexsessions.ts` reads the rest.
  if (item.type === 'collab_tool_call' && item.tool === 'wait') return { id: item.id, text: WAIT, detail: null, state };
  if (item.type === 'web_search') {
    // Started, Codex doesn't know the query yet; completed says what it did.
    const action = item.action ?? {};
    if (action.type === 'open_page') return { id: item.id, text: 'Open a page', detail: shorten(action.url ?? null), state };
    if (action.type === 'find_in_page') return { id: item.id, text: 'Find in a page', detail: shorten(action.pattern ?? action.url ?? null), state };
    return { id: item.id, text: 'Search the web', detail: shorten(action.query || item.query || null), state };
  }
  return null;
}

/**
 * Codex runs each command through the user's login shell, `/bin/zsh -lc '…'`;
 * the panel shows the command that was asked for.
 */
export function unwrapShell(command: string): string {
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(command.trim());
  if (!wrapped) return command.trim();
  return wrapped[1] === "'" ? wrapped[2]!.replaceAll(`'\\''`, `'`) : wrapped[2]!;
}

/**
 * "Gmail: get thread" for a connector's tool. Claude Code names its claude.ai
 * connectors `claude_ai_Gmail`; Codex reaches its apps through one server,
 * `codex_apps`, whose tool names start with the app's.
 */
export function connectorLabel(server: string, tool: string): string {
  const words = (name: string): string => name.replace(/[_-]+/g, ' ').trim();
  if (server === 'codex_apps') {
    const said = words(tool);
    return said.charAt(0).toUpperCase() + said.slice(1);
  }
  return `${words(server.replace(/^claude_ai_/, ''))}: ${words(tool)}`;
}

/** A tool's arguments in a line: the JSON, unless there are none. */
export function compactArgs(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'object' && Object.keys(input).length === 0) return null;
  return shorten(typeof input === 'string' ? input : JSON.stringify(input));
}

/** The first line, and no more than `DETAIL_LENGTH` of it. */
export function shorten(value: string | null): string | null {
  if (!value) return null;
  const lines = value.trim().split('\n');
  const first = lines[0]!.trim();
  const more = lines.length > 1;
  if (first.length > DETAIL_LENGTH) return `${first.slice(0, DETAIL_LENGTH - 1)}…`;
  return more ? `${first} …` : first;
}

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
  private readonly execFn: ExecFile | undefined;
  /** Refuses a Codex too old to hold to the connector rules; see `codex.ts`. */
  private readonly codexGate: CodexGate;
  /** What switches computer use off, once Codex has said; see `computerUseConfig`. */
  private codexOff: Promise<string[]> | null = null;

  constructor(config: Config, hooks: AssistantHooks, spawnFn: typeof spawn = spawn, execFn?: ExecFile) {
    this.config = config;
    this.hooks = hooks;
    // Swapped in by tests, which run a script in place of the CLI, and answer
    // for `codex mcp list` themselves.
    this.spawnFn = spawnFn;
    this.execFn = execFn;
    this.codexGate = new CodexGate(config.assistant.binPath, execFn);
  }

  get enabled(): boolean {
    return this.config.assistant.agent !== null;
  }

  /** Whether any turn has a process going right now. */
  get busy(): boolean {
    return this.running.size > 0;
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
      turn.error = RESTARTED;
      turn.endedAt = new Date().toISOString();
      await this.append({
        event: 'aborted',
        turn: turn.id,
        sessionId: turn.sessionId,
        reason: turn.error,
        reply: turn.reply,
        steps: turn.steps,
        at: turn.endedAt,
      });
    }
  }

  /**
   * Every turn the dashboard started on its own, however old: what has been
   * asked ahead is never asked again, and the panel's window of recent turns
   * is no record of that.
   */
  autoTurns(): AssistantTurn[] {
    return [...this.turns.values()].filter((turn) => turn.auto !== null);
  }

  /** The assistant's half of the state. Asking ahead is `autoask.ts`'s to add, since it needs the board. */
  view(): Omit<AssistantState, 'auto'> {
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
   * the answer arrives through `onChange` and the next state. `auto` marks a
   * turn the dashboard started on its own, with the key of what it answers.
   */
  async ask(ask: AskRequest, context: AskContext, options: { auto?: string } = {}): Promise<AssistantTurn> {
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
      auto: options.auto ?? null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      reply: '',
      steps: [],
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
      ...(turn.auto ? { auto: turn.auto } : {}),
      at: turn.startedAt,
    });

    const prompt = previous
      ? resolved.request
      : composePrompt(await this.instructions(), context, resolved.request, this.config.profile);

    await mkdir(this.config.assistantDir, { recursive: true });
    const refusal = agent === 'codex' ? await this.codexGate.refusal() : null;
    if (refusal) {
      await this.finish(turn, { ok: false, error: refusal });
      return turn;
    }
    let codexConfig: string[];
    try {
      codexConfig = await this.computerUseConfig();
    } catch (err) {
      const error =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? this.spawnError(err)
          : `computer use is off in the settings, and Codex could not confirm it: ${(err as Error).message}. ` +
            'Update Codex, or turn computer use on for the assistant';
      await this.finish(turn, { ok: false, error });
      return turn;
    }
    const adapter = ADAPTERS[agent];
    const args = adapter.args({
      prompt,
      sessionId: previous,
      model: this.config.assistant.model,
      effort: this.config.assistant.effort,
      tools: this.config.assistant.tools,
      denyEdits: true,
      drafts: true,
      codexConfig,
    });

    let child: ChildProcess;
    try {
      const launch = launchFor(this.config.assistant.binPath, args);
      child = this.spawnFn(launch.file, launch.args, {
        cwd: this.config.assistantDir,
        // Stdin closed: both CLIs wait on it otherwise, one of them for three seconds.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cliEnvironment(this.config.dataDir),
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
    // Each tool call's step, by the CLI's id for the call, for the line that says how it went.
    const calls = new Map<string, AssistantStep>();
    if (child.stdout) {
      const lines = createInterface({ input: child.stdout });
      lines.on('line', (line) => {
        const event = adapter.parse(line);
        if (!event) return;
        if (event.sessionId) turn.sessionId = event.sessionId;
        // Everything said is a step until the turn is over; the last of it is
        // then the answer, and comes out of the trail (see `finish`).
        if (event.text) addStep(turn, { kind: 'message', text: event.text, detail: null, state: 'done' });
        for (const parsed of event.steps ?? []) {
          const known = calls.get(parsed.id);
          if (known) {
            if (parsed.text) known.text = parsed.text;
            if (parsed.detail) known.detail = parsed.detail;
            known.state = parsed.state;
          } else if (parsed.text) {
            const step: AssistantStep = { kind: 'tool', text: parsed.text, detail: parsed.detail ?? null, state: parsed.state };
            calls.set(parsed.id, step);
            addStep(turn, step);
          }
        }
        if (event.text || event.steps) this.hooks.onChange();
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
    stopProcess(run.child);
    return true;
  }

  /** Kill everything, for shutdown. The exit handlers write the aborted lines. */
  async close(): Promise<void> {
    for (const itemId of [...this.running.keys()]) await this.stop(itemId, SHUT_DOWN);
  }

  private async finish(turn: AssistantTurn, outcome: NonNullable<ParsedEvent['done']>, aborted = false): Promise<void> {
    const at = new Date().toISOString();
    // The reply is the whole record. Nothing the assistant says is copied onto
    // the item: the chat is where the user asked, and the chat is where the
    // answer stays.
    //
    // Finished, the last thing said is the answer, and it is said once: as the
    // reply, not again as the last step on the way to it. Stopped or failed, it
    // was only ever on the way — both CLIs send an answer whole, at the end — so
    // all of it stays in the steps.
    const last = turn.steps.findLast((step) => step.kind === 'message');
    const reply = outcome.ok ? (outcome.reply ?? last?.text ?? '') : '';
    if (outcome.ok && last && sameWords(last.text, reply)) turn.steps.splice(turn.steps.lastIndexOf(last), 1);
    // A call nobody reported back on went the way the turn did.
    for (const step of turn.steps) if (step.state === 'running') step.state = outcome.ok ? 'done' : 'failed';
    turn.reply = reply;
    turn.endedAt = at;
    const steps = turn.steps;
    if (outcome.ok) {
      turn.status = 'done';
      await this.append({ event: 'finished', turn: turn.id, sessionId: turn.sessionId, reply, steps, at });
    } else if (aborted) {
      turn.status = 'aborted';
      turn.error = outcome.error ?? 'stopped';
      await this.append({ event: 'aborted', turn: turn.id, sessionId: turn.sessionId, reason: turn.error, reply, steps, at });
    } else {
      turn.status = 'failed';
      turn.error = outcome.error ?? 'failed';
      await this.append({ event: 'failed', turn: turn.id, sessionId: turn.sessionId, error: turn.error, reply, steps, at });
    }
    this.hooks.onChange();
  }

  /**
   * What switches computer use off, when the assistant runs Codex and the user
   * hasn't turned it on. Asked of Codex once and kept for the life of the
   * process; settings that change it restart the dashboard anyway. A failure
   * isn't kept, so the next turn asks again.
   */
  private computerUseConfig(): Promise<string[]> {
    if (this.config.assistant.agent !== 'codex' || this.config.assistant.computerUse) return Promise.resolve([]);
    this.codexOff ??= computerUseOff(this.config.assistant.binPath, this.execFn).catch((err: unknown) => {
      this.codexOff = null;
      throw err;
    });
    return this.codexOff;
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
