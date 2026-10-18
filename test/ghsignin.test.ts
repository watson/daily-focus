/**
 * Signing in to GitHub from the page, against a stand-in for gh that says what
 * `gh auth login --web` says with no terminal, and waits for a file where the
 * real one waits for GitHub.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { deviceCode, GitHubSignIn } from '../src/ghsignin.ts';
import { fakeCli, quoted } from './fakecli.ts';

const dirs: string[] = [];

after(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A gh that prints a code, then waits for `entered` to appear, then ends as `then` says. */
async function fakeGh(then: string): Promise<{ gh: string; entered: string; argsFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-ghsignin-'));
  dirs.push(dir);
  const entered = join(dir, 'entered');
  const argsFile = join(dir, 'args');
  const gh = await fakeCli(
    join(dir, 'gh'),
    [
      `fs.writeFileSync(${quoted(argsFile)}, JSON.stringify({ args, prompts: process.env.GH_PROMPT_DISABLED }));`,
      "process.stderr.write('\\n! First copy your one-time code: AB12-CD34\\nOpen this URL to continue in your web browser: https://github.com/login/device\\n');",
      `while (!fs.existsSync(${quoted(entered)})) sleep(20);`,
      then,
    ].join('\n'),
  );
  return { gh, entered, argsFile };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('the code and the link are shown, and a finished sign-in says who', async () => {
  const { gh, entered, argsFile } = await fakeGh("process.stderr.write('✓ Authentication complete.\\n✓ Logged in as alice\\n'); process.exit(0);");
  let signedIn = 0;
  const signIn = new GitHubSignIn({ ghPath: gh, ghBundled: true }, { onChange: () => {}, onSignedIn: () => signedIn++ });
  assert.equal(signIn.view().status, 'idle');
  assert.equal(signIn.view().bundled, true);

  signIn.start();
  assert.equal(signIn.view().status, 'starting');
  assert.equal(signIn.busy, true);
  await until(() => signIn.view().status === 'waiting', 'the code');
  assert.equal(signIn.view().code, 'AB12-CD34');
  assert.equal(signIn.view().url, 'https://github.com/login/device');

  signIn.start();
  await writeFile(entered, '');
  await until(() => signIn.view().status === 'done', 'the end');
  assert.deepEqual(signIn.view(), { bundled: true, status: 'done', code: null, url: null, login: 'alice', error: null });
  assert.equal(signedIn, 1, 'one gh, though Sign in was pressed twice');
  assert.equal(signIn.busy, false);

  const { args, prompts } = JSON.parse(await readFile(argsFile, 'utf8')) as { args: string[]; prompts: string };
  assert.deepEqual(args, ['auth', 'login', '--web', '--hostname', 'github.com']);
  assert.equal(prompts, '1', 'gh never waits on a keypress');
});

test('a sign-in gh gives up on says why', async () => {
  const { gh, entered } = await fakeGh("fail('failed to authenticate via web browser: expired_token');");
  let signedIn = 0;
  const signIn = new GitHubSignIn({ ghPath: gh, ghBundled: false }, { onChange: () => {}, onSignedIn: () => signedIn++ });
  signIn.start();
  await until(() => signIn.view().status === 'waiting', 'the code');
  await writeFile(entered, '');
  await until(() => signIn.view().status === 'failed', 'the failure');
  assert.equal(signIn.view().error, 'failed to authenticate via web browser: expired_token');
  assert.equal(signIn.view().code, null, 'a code that no longer works is not shown');
  assert.equal(signedIn, 0);
});

test('cancelling stops gh and goes back to the button', async () => {
  const { gh } = await fakeGh('process.exit(0);');
  let signedIn = 0;
  const signIn = new GitHubSignIn({ ghPath: gh, ghBundled: false }, { onChange: () => {}, onSignedIn: () => signedIn++ });
  signIn.start();
  await until(() => signIn.view().status === 'waiting', 'the code');
  await signIn.cancel();
  assert.equal(signIn.busy, false, 'gone by the time it resolves');
  assert.deepEqual(signIn.view(), { bundled: false, status: 'idle', code: null, url: null, login: null, error: null });
  assert.equal(signedIn, 0);
});

test('a gh that is not there says so', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'daily-focus-ghsignin-'));
  dirs.push(dir);
  const signIn = new GitHubSignIn({ ghPath: join(dir, 'no-gh'), ghBundled: false }, { onChange: () => {}, onSignedIn: () => {} });
  signIn.start();
  await until(() => signIn.view().status === 'failed', 'the failure');
  assert.match(signIn.view().error ?? '', /could not run .*no-gh/);
});

test("the code is read from either of gh's ways of saying it", () => {
  assert.equal(deviceCode('\n! First copy your one-time code: AB12-CD34\nOpen this URL…'), 'AB12-CD34', 'up to 2.98');
  assert.equal(deviceCode('! One-time code (AB12-CD34) copied to clipboard\nOpen this URL…'), 'AB12-CD34', 'by 2.102');
  assert.equal(deviceCode('Open this URL to continue in your web browser: https://github.com/login/device'), null, 'not yet');
});
