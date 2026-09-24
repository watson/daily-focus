/**
 * The morning agent, started by hand from the dashboard.
 *
 * The scheduler is still where the agent normally runs. This is for the day that
 * went sideways by eleven — a morning of meetings moved, a fire started, a brief
 * that no longer describes anything — when waiting for tomorrow's run is the
 * wrong answer. It starts the same agent the scheduler does, on the same wrapper
 * prompt, in the same directory, so a hand-started brief is a brief like any
 * other rather than a second, subtly different kind.
 *
 * What that buys, and what it keeps:
 *
 *  - The agent is still the only writer of `items.json`. The dashboard starts
 *    the process and reads what it prints; it never writes the brief, and it
 *    never hands the agent anything the store doesn't already hold.
 *  - The run's working directory is the store, as the scheduled task's is. For
 *    Codex that is the whole write policy: its sandbox confines writes to it.
 *    Claude Code is held to `items.json` and its temporary sibling by its tool
 *    list. Neither can reach a source checkout, which is the boundary
 *    `prompts/README.md` insists on.
 *  - The brief lands the way every brief lands: the store watcher sees the
 *    rename, archives it and pushes it to every tab. Nothing here has to.
 *  - What the agent reports back — its prompt ends by asking for one — is kept
 *    in `agent.jsonl`, which this file alone writes and nothing compacts. On a
 *    schedule that report goes wherever the scheduler puts it; here it is shown
 *    under the header, since the person who pressed the button is right there.
 *
 * One run at a time. The dashboard cannot see the scheduler, so a scheduled run
 * that starts while this one is going is not prevented. Both rename a complete
 * file over the brief, so the later one wins and neither is ever half-written.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

import { ADAPTERS, type ParsedEvent } from './assistant.ts';
import type { CliName, Config } from './config.ts';
import type { AgentRun, AgentRunState } from './types.ts';

/**
 * A run that takes longer than this is killed. A brief at high effort across a
 * dozen sources takes a quarter of an hour on a slow day; an hour is an agent
 * that is stuck, not thorough.
 */
const RUN_TIMEOUT_MS = 60 * 60_000;

/**
 * The prompt the run is started with: the wrapper `prompts/README.md` tells the
 * user to put in their scheduler, word for word, with the store's real path.
 * Word for word so the two runs can't drift apart — the contract test checks it
 * against the README — and so everything that evolves stays in the prompt file,
 * which is re-read every run.
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

/** `~/.daily-focus/prompt.md` rather than the expanded path, as the README writes it. */
export function displayPath(path: string, home: string = homedir()): string {
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/* ---------- the log ---------- */

/** One line in agent.jsonl. */
type LogRecord =
  | { event: 'started'; run: string; cli: CliName; at: string }
  | { event: 'finished'; run: string; sessionId: string | null; report: string; at: string }
  | { event: 'failed'; run: string; sessionId: string | null; error: string; report: string; at: string }
  | { event: 'aborted'; run: string; sessionId: string | null; reason: string; report: string; at: string };

/** Fold the log into runs, oldest first. Forgiving line by line, as the other logs are. */
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
        sessionId: null,
        startedAt: record.at,
        endedAt: null,
        status: 'running',
        report: '',
        error: null,
      });
      continue;
    }

    const run = runs.get(record.run);
    if (!run) continue;
    run.sessionId = typeof record.sessionId === 'string' ? record.sessionId : run.sessionId;
    run.report = typeof record.report === 'string' ? record.report : run.report;
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

interface Running {
  run: AgentRun;
  child: ChildProcess;
  timer: NodeJS.Timeout;
  /** Set by `stop`, so the exit handler can tell a kill from a crash. */
  abortReason: string | null;
}

export interface AgentRunnerHooks {
  /** Something changed that a tab should see. */
  onChange: () => void;
}

export class AgentRunner {
  private last: AgentRun | null = null;
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
   * Read the log, and close a run left going when the last process died: its
   * child died with it, so a spinner would never stop.
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
    const runs = foldAgentLog(text);
    for (const run of runs) {
      if (run.status !== 'running') continue;
      run.status = 'aborted';
      run.error = 'the dashboard restarted while this was running';
      run.endedAt = new Date().toISOString();
      await this.append({
        event: 'aborted',
        run: run.id,
        sessionId: run.sessionId,
        reason: run.error,
        report: run.report,
        at: run.endedAt,
      });
    }
    this.last = runs.at(-1) ?? null;
  }

  view(): AgentRunState {
    return { enabled: this.enabled, cli: this.config.agent.cli, last: this.last };
  }

  /**
   * Start a run. Returns once the process is running, not once the brief is
   * written; the report arrives through `onChange`, the brief through the store.
   */
  async run(): Promise<AgentRun> {
    const cli = this.config.agent.cli;
    if (!cli) throw new Error('running the morning agent is off; set DAILY_FOCUS_AGENT to codex or claude');
    if (this.running) throw new Error('the morning agent is already running');
    await this.start();

    const run: AgentRun = {
      id: randomUUID(),
      cli,
      sessionId: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      status: 'running',
      report: '',
      error: null,
    };
    this.last = run;
    await this.append({ event: 'started', run: run.id, cli, at: run.startedAt });

    await mkdir(this.config.dataDir, { recursive: true });
    const adapter = ADAPTERS[cli];
    const args = adapter.args({
      prompt: agentPrompt(displayPath(this.config.promptFile)),
      sessionId: null,
      model: this.config.agent.model,
      effort: this.config.agent.effort,
      tools: this.config.agent.tools,
      denyEdits: false,
    });

    let child: ChildProcess;
    try {
      child = this.spawnFn(this.config.agent.binPath, args, {
        // The store, as the scheduled task's working directory is.
        cwd: this.config.dataDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      await this.finish(run, { ok: false, error: this.spawnError(err) });
      return run;
    }

    const timer = setTimeout(() => void this.stop('gave up after an hour'), RUN_TIMEOUT_MS);
    timer.unref();
    const running: Running = { run, child, timer, abortReason: null };
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
        if (event.sessionId) run.sessionId = event.sessionId;
        // The latest message, not all of them: along the way that is what the
        // agent is doing now, and at the end it is the report.
        if (event.text) {
          run.report = event.text;
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
      void this.finish(run, outcome, running.abortReason !== null);
    });

    return run;
  }

  /**
   * Kill the run, if there is one. Whatever it already renamed into place stays:
   * the brief it replaced is gone either way, and the archive has it.
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

  private async finish(run: AgentRun, outcome: NonNullable<ParsedEvent['done']>, aborted = false): Promise<void> {
    const at = new Date().toISOString();
    // Claude Code hands back a final result; Codex doesn't, and its last
    // message is the report instead.
    const report = outcome.reply ?? run.report;
    run.report = report;
    run.endedAt = at;
    if (outcome.ok) {
      run.status = 'done';
      await this.append({ event: 'finished', run: run.id, sessionId: run.sessionId, report, at });
    } else if (aborted) {
      run.status = 'aborted';
      run.error = outcome.error ?? 'stopped';
      await this.append({ event: 'aborted', run: run.id, sessionId: run.sessionId, reason: run.error, report, at });
    } else {
      run.status = 'failed';
      run.error = outcome.error ?? 'failed';
      await this.append({ event: 'failed', run: run.id, sessionId: run.sessionId, error: run.error, report, at });
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
