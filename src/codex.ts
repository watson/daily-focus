/**
 * What the dashboard tells Codex about permissions, beyond the sandbox.
 *
 * A Codex run inherits the user's own `~/.codex/config.toml`: its approval
 * policy, its approvals reviewer, its rules, its plugins and its MCP servers. The
 * dashboard leaves the shell side of that alone on purpose. `gh` reaches GitHub
 * through it, and some briefs depend on commands the user's rules let out of the
 * sandbox, so those keep working exactly as they do in the user's own Codex.
 *
 * Two things are tightened, for every run the dashboard starts:
 *
 *  - Connector tools (Gmail, Calendar, Drive, GitHub and the rest of the apps a
 *    ChatGPT account links) may only read. Every app tool not marked read-only
 *    needs approval, and that approval is routed to "user", which a headless
 *    `codex exec` cancels at once: the call is refused, and the run carries on.
 *    The shell's approvals still go wherever the user's config sends them.
 *  - The assistant may create and revise Gmail drafts, the one write its
 *    instructions ask for. Nothing else gets that exception.
 *
 * And one is the user's choice: whether the assistant may use computer use, the
 * plugins and MCP servers that act in the user's apps and browser with their
 * sign-ins. Off by default; `computerUseOff` works out what to switch off.
 *
 * A tool the user has told Codex to always allow, or an app given its own
 * approval settings in their config, keeps them: Codex lets the more specific
 * setting win. SETUP.md says so.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { ExecFile } from './shellpath.ts';

/** Gmail's connector id. The same for every ChatGPT account. */
export const GMAIL_CONNECTOR = 'connector_2128aebfecb84f64a069897515042a44';

/**
 * Every app tool that isn't read-only asks for approval, and the asking goes to a
 * user who isn't there. Overrides in Codex's `-c key=value` form.
 */
export const CONNECTOR_POLICY: readonly string[] = [
  'apps._default.default_tools_approval_mode="writes"',
  'apps._default.approvals_reviewer="user"',
];

/** The assistant's one exception: drafting a Gmail reply, and revising it when asked. */
export const GMAIL_DRAFTS: readonly string[] = ['create_draft', 'update_draft'].map(
  (tool) => `apps.${GMAIL_CONNECTOR}.tools.${tool}.approval_mode="approve"`,
);

/**
 * The bundled plugins that drive the user's computer or browser. Turning a plugin
 * off by name is harmless when it isn't installed, so these always go.
 */
export const COMPUTER_USE_PLUGINS: readonly string[] = [
  'unified-computer-use@openai-bundled',
  'computer-use@openai-bundled',
  'browser@openai-bundled',
  'chrome@openai-bundled',
];

/**
 * The MCP servers those plugins run on. The ChatGPT app writes `node_repl` into
 * the user's own config rather than into a plugin, so turning the plugins off
 * can leave it running.
 */
export const COMPUTER_USE_SERVERS: readonly string[] = ['node_repl', 'cua_repl', 'computer-use'];

/** How long Codex gets to list its servers or say its version. */
const LIST_TIMEOUT_MS = 30_000;

const exec = promisify(execFile);

/**
 * Runs Codex and resolves with what it printed, or rejects when it fails. Only
 * stderr goes into an error: `mcp list --json` prints each server's environment,
 * which can hold a token.
 */
const defaultExec: ExecFile = async (file, args, { timeout }) => {
  try {
    const { stdout } = await exec(file, args, { timeout, maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const stderr = String((err as { stderr?: unknown }).stderr ?? '').trim();
    // Nothing on stderr: a missing binary or a timeout, whose code the caller reads.
    if (!stderr) throw err;
    throw new Error(stderr.split('\n').slice(0, 2).join(' '));
  }
};

/**
 * `-c` before each override, as Codex takes them. Codex splits the key on every
 * dot and keeps any quotes as part of a name, so keys go unquoted: the plugin and
 * server names here have no dots in them. A quoted name would point at a key that
 * doesn't exist, which for a plugin is silently nothing and for a server stops
 * Codex starting.
 */
export function configArgs(overrides: readonly string[]): string[] {
  return overrides.flatMap((override) => ['-c', override]);
}

/** The names of the MCP servers Codex would start with these overrides. */
async function enabledServers(bin: string, overrides: readonly string[], run: ExecFile): Promise<string[]> {
  const output = await run(bin, ['mcp', 'list', '--json', ...configArgs(overrides)], { timeout: LIST_TIMEOUT_MS });
  let servers: unknown;
  try {
    servers = JSON.parse(output);
  } catch {
    throw new Error('codex mcp list --json printed something other than JSON');
  }
  if (!Array.isArray(servers)) throw new Error('codex mcp list --json printed something other than a list');
  return servers
    .filter((server): server is { name: string; enabled?: unknown } => typeof server?.name === 'string')
    .filter((server) => server.enabled !== false)
    .map((server) => server.name);
}

/**
 * The overrides that switch computer use off for a run, checked against Codex's
 * own list of what it would start.
 *
 * The plugins go first, by name. Whatever computer-use server is still running
 * after that came from the user's own config, so it can be switched off by name
 * too; Codex refuses to start at all if a server named that way doesn't exist,
 * which is why the list is asked rather than guessed. Throws when the result
 * can't be confirmed, so a run never starts with computer use quietly on.
 */
export async function computerUseOff(bin: string, run: ExecFile = defaultExec): Promise<string[]> {
  const overrides = COMPUTER_USE_PLUGINS.map((plugin) => `plugins.${plugin}.enabled=false`);
  const left = (await enabledServers(bin, overrides, run)).filter((name) => COMPUTER_USE_SERVERS.includes(name));
  if (left.length === 0) return overrides;

  overrides.push(...left.map((name) => `mcp_servers.${name}.enabled=false`));
  const still = (await enabledServers(bin, overrides, run)).filter((name) => COMPUTER_USE_SERVERS.includes(name));
  if (still.length > 0) throw new Error(`Codex still starts ${still.join(', ')}`);
  return overrides;
}

/**
 * The Codex these settings were last checked against. An older one may not know
 * them, and Codex ignores a setting it doesn't know rather than refusing it.
 */
export const CODEX_CHECKED = '0.162.1';

function versionParts(text: string): number[] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match ? match.slice(1, 4).map(Number) : null;
}

/** True when `version` is older than `than`. Unparseable is not older: there is nothing to say about it. */
export function olderThan(version: string, than: string): boolean {
  const a = versionParts(version);
  const b = versionParts(than);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! < b[i]!;
  }
  return false;
}

/**
 * A setup warning when this Codex is older than the one the dashboard's limits
 * were checked against, or null. A Codex that can't be run says nothing here:
 * the run that needs it says so, with the setting that fixes it.
 */
export async function codexVersionWarning(bin: string, run: ExecFile = defaultExec): Promise<string | null> {
  let output: string;
  try {
    output = await run(bin, ['--version'], { timeout: LIST_TIMEOUT_MS });
  } catch {
    return null;
  }
  const version = versionParts(output)?.join('.');
  if (!version || !olderThan(version, CODEX_CHECKED)) return null;
  return (
    `Codex ${version} is older than ${CODEX_CHECKED}, the version the dashboard's limits on Codex were checked ` +
    'against. An older Codex may ignore them, which would let the agent and the assistant write through your ' +
    'connectors and, with computer use off, still use it. Update Codex with `codex update`.'
  );
}
