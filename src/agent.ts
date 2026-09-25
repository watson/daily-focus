/**
 * The morning agent, run by the dashboard.
 *
 * Two ways a run starts, one kind of run. The dashboard's own clock starts one
 * each scheduled morning at `DAILY_FOCUS_AGENT_AT`, so a working brief needs
 * nothing outside this process but the CLI. A click starts one for the day that
 * went sideways by eleven — a morning of meetings moved, a fire started, a brief
 * that no longer describes anything. Both start the same agent on the same
 * wrapper prompt in the same directory, and both land in the same log, so a
 * hand-started brief is a brief like any other rather than a second, subtly
 * different kind.
 *
 * What that buys, and what it keeps:
 *
 *  - The agent is still the only writer of `items.json`. The dashboard starts
 *    the process and reads what it prints; it never writes the brief, and it
 *    never hands the agent anything the store doesn't already hold.
 *  - The run's working directory is the store. For Codex that is the whole
 *    write policy: its sandbox confines writes to it. Claude Code is held to
 *    `items.json` and its temporary sibling by its tool list. Neither can reach
 *    a source checkout, which is the boundary `prompts/README.md` insists on.
 *  - The brief lands the way every brief lands: the store watcher sees the
 *    rename, archives it and pushes it to every tab. Nothing here has to.
 *  - What the agent reports back — its prompt ends by asking for one — is kept
 *    in `agent.jsonl`, which this file alone writes and nothing compacts, with
 *    everything it said on the way there and every question asked of the run
 *    afterwards. "Why did you drop this",
 *    "go and find the document you couldn't read": each resumes the run's own
 *    session, so the agent answers from what it actually did rather than from a
 *    summary of it. A follow-up is given nothing to write. Under Claude Code the
 *    editing tools are denied and the brief-writing rules withheld; under Codex,
 *    whose sandbox has no per-file policy, the question is framed to say so.
 *
 * One process at a time, run or follow-up. The dashboard cannot see any other
 * scheduler, so a run started elsewhere while this one is going is not
 * prevented; both rename a complete file over the brief, so the later one wins
 * and neither is ever half-written. The clock defers to a brief something else
 * wrote today, so an old scheduled task and this one don't both run.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

import { ADAPTERS, type ParsedEvent } from './assistant.ts';
import { briefWritingTools, type CliName, type Config } from './config.ts';
import { describeTime, nextScheduledRun, resolveSchedule, scheduledRunDue } from './schedule.ts';
import type { AgentRun, AgentRunState, AgentTurn } from './types.ts';

/**
 * A run that takes longer than this is killed. A brief at high effort across a
 * dozen sources takes a quarter of an hour on a slow day; an hour is an agent
 * that is stuck, not thorough.
 */
const RUN_TIMEOUT_MS = 60 * 60_000;

/** A follow-up that runs longer than this is killed, as the assistant's turns are. */
const TURN_TIMEOUT_MS = 10 * 60_000;

/** How many runs the client is sent. The log keeps all of them. */
const RUNS_SHOWN = 30;

/**
 * The prompt the run is started with: the wrapper `prompts/README.md` gives for
 * any other scheduler, word for word, with the store's real path. Word for word
 * so two ways of running the agent can't drift apart — the contract test checks
 * it against the README — and so everything that evolves stays in the prompt
 * file, which is re-read every run.
 */
export function agentPrompt(promptPath: string): string {
  return [
    'Run my morning brief for today.',
    '',
    'Your full instructions are in this file — read it now and follow it exactly,',
    'including every step it lists and the verification checks it ends with:',
    '',
    `  ${promptPath}`,
    '',
    'That file is the source of truth and it changes over time. Re-read it on every',
    'run; never work from your memory of a previous run.',
    '',
    'Finish by reporting back as that file asks you to.',
  ].join('\n');
}

/**
 * A question asked of a finished run, as sent. The framing is the one rule a
 * follow-up needs and the runner cannot enforce under every CLI: the brief is
 * not to be rewritten from a chat. Anything the agent should have done
 * differently is a rerun, which starts from the prompt and the store like every
 * run, not a patch applied from memory of a conversation.
 */
export function followUpPrompt(question: string): string {
  return [
    'A follow-up question about the brief you wrote in this session. Answer it here.',
    'Read whatever you need to, but do not write or change any file, and do not',
    'rewrite the brief: if something in it should change, say what and why, and I',
    'will run you again.',
    '',
    question.trim(),
  ].join('\n');
}

/** `~/.daily-focus/prompt.md` rather than the expanded path, as the README writes it. */
export function displayPath(path: string, home: string = homedir()): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/* ---------- the log ---------- */

/** One line in agent.jsonl. */
type LogRecord =
  | { event: 'started'; run: string; cli: CliName; trigger: AgentRun['trigger']; at: string }
  | { event: 'finished'; run: string; sessionId: string | null; report: string; messages: string[]; at: string }
  | { event: 'failed'; run: string; sessionId: string | null; error: string; report: string; messages: string[]; at: string }
  | { event: 'aborted'; run: string; sessionId: string | null; reason: string; report: string; messages: string[]; at: string }
  | { event: 'asked'; run: string; turn: string; question: string; at: string }
  | { event: 'replied'; run: string; turn: string; reply: string; at: string }
  | { event: 'turn-failed'; run: string; turn: string; error: string; reply: string; at: string }
  | { event: 'turn-aborted'; run: string; turn: string; reason: string; reply: string; at: string };

/**
 * Fold the log into runs, oldest first. Forgiving line by line, as the other
 * logs are. `resumable` is left false: only the runner knows which CLI is
 * configured now.
 */
export function foldAgentLog(text: string): AgentRun[] {
  const runs = new Map<string, AgentRun>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let record: LogRecord;
    try {
      record = JSON.parse(line) as LogRecord;
    } catch {
      continue;
    }
    if (typeof record !== 'object' || record === null || typeof record.run !== 'string') continue;

    if (record.event === 'started') {
      runs.set(record.run, {
        id: record.run,
        cli: record.cli,
        // Runs logged before the dashboard had a clock were all started by hand.
        trigger: record.trigger === 'schedule' ? 'schedule' : 'hand',
        sessionId: null,
        startedAt: record.at,
        endedAt: null,
        status: 'running',
        report: '',
        messages: [],
        error: null,
        turns: [],
        resumable: false,
      });
      continue;
    }

    const run = runs.get(record.run);
    if (!run) continue;

    if (record.event === 'asked') {
      if (typeof record.turn !== 'string' || typeof record.question !== 'string') continue;
      run.turns.push({
        id: record.turn,
        question: record.question,
        startedAt: record.at,
        endedAt: null,
        status: 'running',
        reply: '',
        error: null,
      });
      continue;
    }
    if (record.event === 'replied' || record.event === 'turn-failed' || record.event === 'turn-aborted') {
      const turn = run.turns.find((candidate) => candidate.id === record.turn);
      if (!turn) continue;
      turn.reply = typeof record.reply === 'string' ? record.reply : turn.reply;
      turn.endedAt = record.at;
      if (record.event === 'replied') {
        turn.status = 'done';
      } else if (record.event === 'turn-failed') {
        turn.status = 'failed';
        turn.error = record.error;
      } else {
        turn.status = 'aborted';
        turn.error = record.reason;
      }
      continue;
    }

    run.sessionId = typeof record.sessionId === 'string' ? record.sessionId : run.sessionId;
    run.report = typeof record.report === 'string' ? record.report : run.report;
    // Lines written before the commentary was kept have only the report.
    run.messages = Array.isArray(record.messages)
      ? record.messages.filter((message): message is string => typeof message === 'string')
      : run.report
        ? [run.report]
        : [];
    run.endedAt = record.at;
    if (record.event === 'finished') {
      run.status = 'done';
    } else if (record.event === 'failed') {
      run.status = 'failed';
      run.error = record.error;
    } else if (record.event === 'aborted') {
      run.status = 'aborted';
      run.error = record.reason;
    }
  }
  return [...runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

/* ---------- the runner ---------- */

/** What is going on, whether that is a run or a question asked of one. */
interface Running {
  run: AgentRun;
  /** Set when the process is answering a follow-up rather than writing the brief. */
  turn: AgentTurn | null;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  /** Set by `stop`, so the exit handler can tell a kill from a crash. */
  abortReason: string | null;
}

export interface AgentRunnerHooks {
  /** Something changed that a tab should see. */
  onChange: () => void;
  /**
   * When the brief on disk was written, for the clock: a brief written today by
   * anything at all means today's run has happened.
   */
  briefGeneratedAt?: () => Promise<string | null>;
}

export class AgentRunner {
  /** Every run in the log, oldest first. */
  private runs: AgentRun[] = [];
  private running: Running | null = null;
  private loaded = false;
  private readonly config: Config;
  private readonly hooks: AgentRunnerHooks;
  private readonly spawnFn: typeof spawn;

  constructor(config: Config, hooks: AgentRunnerHooks, spawnFn: typeof spawn = spawn) {
    this.config = config;
    this.hooks = hooks;
    // Swapped in by tests, which run a script in place of the CLI.
    this.spawnFn = spawnFn;
  }

  get enabled(): boolean {
    return this.config.agent.cli !== null;
  }

  /**
   * Read the log, and close whatever was left going when the last process died:
   * its child died with it, so a spinner would never stop.
   */
  async start(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    let text = '';
    try {
      text = await readFile(this.config.agentLogFile, 'utf8');
    } catch {
      return;
    }
    this.runs = foldAgentLog(text);
    const at = new Date().toISOString();
    const reason = 'the dashboard restarted while this was running';
    for (const run of this.runs) {
      if (run.status === 'running') {
        run.status = 'aborted';
        run.error = reason;
        run.endedAt = at;
        await this.append({ event: 'aborted', run: run.id, sessionId: run.sessionId, reason, report: run.report, messages: run.messages, at });
      }
      for (const turn of run.turns) {
        if (turn.status !== 'running') continue;
        turn.status = 'aborted';
        turn.error = reason;
        turn.endedAt = at;
        await this.append({ event: 'turn-aborted', run: run.id, turn: turn.id, reason, reply: turn.reply, at });
      }
    }
  }

  /** The newest run, whatever became of it. */
  get last(): AgentRun | null {
    return this.runs.at(-1) ?? null;
  }

  view(now: Date = new Date()): AgentRunState {
    const runs = this.runs.slice(-RUNS_SHOWN).reverse().map((run) => ({ ...run, resumable: this.resumable(run) }));
    return {
      enabled: this.enabled,
      cli: this.config.agent.cli,
      schedule: this.scheduleView(now),
      last: runs[0] ?? null,
      runs,
    };
  }

  private scheduleView(now: Date): AgentRunState['schedule'] {
    const at = this.config.agent.at;
    if (!at || !this.enabled) return null;
    return { at: describeTime(at), nextRunAt: this.nextRunAt?.toISOString() ?? null };
  }

  /** Worked out by the last tick, since it needs the schedule and the brief off disk. */
  private nextRunAt: Date | null = null;

  /**
   * The clock. Called every so often by the server, and once at startup: if a
   * run is due and nothing has produced today's brief, start one. Never throws;
   * a clock that can't read the brief has nothing to say about it.
   */
  async tick(now: Date = new Date()): Promise<void> {
    const at = this.config.agent.at;
    if (!at || !this.enabled) return;
    await this.start();
    let due = false;
    try {
      const input = {
        at,
        schedule: await resolveSchedule(this.config, now),
        lastRunStartedAt: this.last?.startedAt ?? null,
        briefGeneratedAt: (await this.hooks.briefGeneratedAt?.()) ?? null,
        now,
      };
      const next = nextScheduledRun(input);
      if ((next?.getTime() ?? null) !== (this.nextRunAt?.getTime() ?? null)) {
        this.nextRunAt = next;
        this.hooks.onChange();
      }
      due = scheduledRunDue(input);
    } catch (err) {
      console.error(`[daily-focus] the morning agent's clock could not decide: ${(err as Error).message}`);
      return;
    }
    if (!due || this.running) return;
    console.log(`[daily-focus] starting the morning agent, due ${describeTime(at)}`);
    await this.run('schedule', now);
  }

  /**
   * Start a run. Returns once the process is running, not once the brief is
   * written; the report arrives through `onChange`, the brief through the store.
   * `now` is the clock's, so a run it starts is stamped with the moment it
   * decided on.
   */
  async run(trigger: AgentRun['trigger'] = 'hand', now: Date = new Date()): Promise<AgentRun> {
    const cli = this.config.agent.cli;
    if (!cli) throw new Error('running the morning agent is off; set DAILY_FOCUS_AGENT to codex or claude');
    if (this.running) {
      throw new Error(
        this.running.turn ? 'the morning agent is still answering a question' : 'the morning agent is already running',
      );
    }
    await this.start();

    const run: AgentRun = {
      id: randomUUID(),
      cli,
      trigger,
      sessionId: null,
      startedAt: now.toISOString(),
      endedAt: null,
      status: 'running',
      report: '',
      messages: [],
      error: null,
      turns: [],
      resumable: false,
    };
    this.runs.push(run);
    await this.append({ event: 'started', run: run.id, cli, trigger, at: run.startedAt });

    const adapter = ADAPTERS[cli];
    const args = adapter.args({
      prompt: agentPrompt(displayPath(this.config.promptFile)),
      sessionId: null,
      model: this.config.agent.model,
      effort: this.config.agent.effort,
      tools: [...briefWritingTools(), ...this.config.agent.tools],
      denyEdits: false,
    });

    await this.spawnInto(run, null, args, RUN_TIMEOUT_MS, 'gave up after an hour');
    return run;
  }

  /**
   * Ask a finished run a question, in its own session. Returns once the process
   * is running; the answer arrives through `onChange` and the next state.
   */
  async ask(runId: string, question: string): Promise<AgentTurn> {
    const cli = this.config.agent.cli;
    if (!cli) throw new Error('running the morning agent is off; set DAILY_FOCUS_AGENT to codex or claude');
    await this.start();
    const run = this.runs.find((candidate) => candidate.id === runId);
    if (!run) throw new Error('no such run');
    if (this.running) {
      throw new Error(
        this.running.turn ? 'the morning agent is still answering a question' : 'the morning agent is still running',
      );
    }
    if (!this.resumable(run)) {
      throw new Error(
        run.sessionId === null
          ? 'this run left no session to continue'
          : `this run was made by ${run.cli}, and the agent is ${cli} now`,
      );
    }
    const text = question.trim();
    if (text === '') throw new Error('nothing to ask');

    const turn: AgentTurn = {
      id: randomUUID(),
      question: text,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      reply: '',
      error: null,
    };
    run.turns.push(turn);
    await this.append({ event: 'asked', run: run.id, turn: turn.id, question: text, at: turn.startedAt });

    const adapter = ADAPTERS[cli];
    const args = adapter.args({
      prompt: followUpPrompt(text),
      sessionId: run.sessionId,
      model: this.config.agent.model,
      effort: this.config.agent.effort,
      // The sources, and not the brief: a chat is given nothing to write.
      tools: this.config.agent.tools,
      denyEdits: true,
    });

    await this.spawnInto(run, turn, args, TURN_TIMEOUT_MS, 'gave up after ten minutes');
    return turn;
  }

  /**
   * Start the CLI in the store and read what it says into `turn`, or into the
   * run when there is none. The store in both cases: Claude Code files a
   * session under the directory it was started in, and looks for it there.
   */
  private async spawnInto(run: AgentRun, turn: AgentTurn | null, args: string[], timeoutMs: number, timeoutReason: string): Promise<void> {
    const cli = run.cli;
    const adapter = ADAPTERS[cli];
    await mkdir(this.config.dataDir, { recursive: true });

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.config.agent.binPath, args, {
        cwd: this.config.dataDir,
        // Stdin closed: both CLIs wait on it otherwise.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      await this.finish(run, turn, { ok: false, error: this.spawnError(err) });
      return;
    }

    const timer = setTimeout(() => void this.stop(timeoutReason), timeoutMs);
    timer.unref();
    const running: Running = { run, turn, child, timer, abortReason: null };
    this.running = running;
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
        if (event.sessionId && !turn) run.sessionId = event.sessionId;
        if (event.text) {
          if (turn) {
            turn.reply = turn.reply ? `${turn.reply}\n\n${event.text}` : event.text;
          } else {
            // Every message, in order: along the way the latest is what the
            // agent is doing now, at the end it is the report, and the rest is
            // how it got there.
            run.messages.push(event.text);
            run.report = event.text;
          }
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
      this.running = null;
      const outcome: ParsedEvent['done'] = running.abortReason
        ? { ok: false, error: running.abortReason }
        : (done ?? {
            ok: false,
            error: `${cli} exited with code ${code}${stderr.length ? `: ${stderr.join('').trim().split('\n').slice(-3).join(' ')}` : ''}`,
          });
      void this.finish(run, turn, outcome, running.abortReason !== null);
    });
  }

  /**
   * Kill whatever is going, run or follow-up. What a run already renamed into
   * place stays: the brief it replaced is gone either way, and the archive has it.
   */
  async stop(reason = 'stopped'): Promise<boolean> {
    if (!this.running) return false;
    this.running.abortReason = reason;
    this.running.child.kill('SIGTERM');
    return true;
  }

  /** Kill the run, for shutdown. The exit handler writes the aborted line. */
  async close(): Promise<void> {
    await this.stop('the dashboard shut down');
  }

  private resumable(run: AgentRun): boolean {
    return run.status !== 'running' && run.sessionId !== null && run.cli === this.config.agent.cli;
  }

  private async finish(
    run: AgentRun,
    turn: AgentTurn | null,
    outcome: NonNullable<ParsedEvent['done']>,
    aborted = false,
  ): Promise<void> {
    const at = new Date().toISOString();
    // The log line lands before the status flips, so nothing that sees the
    // run finished can read a log that doesn't say so yet.
    if (turn) {
      const reply = outcome.reply ?? turn.reply;
      turn.reply = reply;
      turn.endedAt = at;
      if (outcome.ok) {
        await this.append({ event: 'replied', run: run.id, turn: turn.id, reply, at });
        turn.status = 'done';
      } else if (aborted) {
        turn.error = outcome.error ?? 'stopped';
        await this.append({ event: 'turn-aborted', run: run.id, turn: turn.id, reason: turn.error, reply, at });
        turn.status = 'aborted';
      } else {
        turn.error = outcome.error ?? 'failed';
        await this.append({ event: 'turn-failed', run: run.id, turn: turn.id, error: turn.error, reply, at });
        turn.status = 'failed';
      }
      this.hooks.onChange();
      return;
    }

    // Claude Code hands back a final result; Codex doesn't, and its last
    // message is the report instead.
    const report = outcome.reply ?? run.report;
    run.report = report;
    run.endedAt = at;
    const messages = run.messages;
    if (outcome.ok) {
      await this.append({ event: 'finished', run: run.id, sessionId: run.sessionId, report, messages, at });
      run.status = 'done';
    } else if (aborted) {
      run.error = outcome.error ?? 'stopped';
      await this.append({ event: 'aborted', run: run.id, sessionId: run.sessionId, reason: run.error, report, messages, at });
      run.status = 'aborted';
    } else {
      run.error = outcome.error ?? 'failed';
      await this.append({ event: 'failed', run: run.id, sessionId: run.sessionId, error: run.error, report, messages, at });
      run.status = 'failed';
    }
    this.hooks.onChange();
  }

  private spawnError(err: unknown): string {
    const code = (err as NodeJS.ErrnoException).code;
    const bin = this.config.agent.binPath;
    if (code === 'ENOENT') return `could not find ${bin}; install it or set DAILY_FOCUS_AGENT_BIN to its path`;
    return `could not run ${bin}: ${err instanceof Error ? err.message : String(err)}`;
  }

  private async append(record: LogRecord): Promise<void> {
    await mkdir(this.config.dataDir, { recursive: true });
    await appendFile(this.config.agentLogFile, `${JSON.stringify(record)}\n`, 'utf8');
  }
}
