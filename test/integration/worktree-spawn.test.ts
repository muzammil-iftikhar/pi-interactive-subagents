/**
 * Integration test: opt-in worktree spawns.
 *
 * Verifies the `worktree: true` path end to end — the parent pi calls the
 * `subagent` tool with `worktree: true`, the extension creates a git worktree
 * via `workmux add --headless --json`, and the subagent runs inside that
 * worktree (its own branch), not the caller's checkout.
 *
 * Requires tmux + workmux + git. Spawns REAL pi sessions (real LLM calls).
 *
 * Run inside tmux:
 *   PI_TEST_MODEL=<your-model> node --test test/integration/worktree-spawn.test.ts
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  startPi,
  waitForFile,
  waitForScreen,
  sleep,
  uniqueId,
  trackTempFile,
  PI_TIMEOUT,
  TEST_MODEL,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();
const hasWorkmux = (() => {
  try {
    execFileSync("sh", ["-c", "command -v workmux"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (backends.length === 0 || !hasWorkmux) {
  console.log(
    `⚠️  Skipping worktree-spawn integration tests (tmux: ${backends.length > 0}, workmux: ${hasWorkmux})`,
  );
}

for (const backend of backends.length > 0 && hasWorkmux ? backends : []) {
  describe(`worktree-spawn [${backend}]`, { timeout: PI_TIMEOUT * 3 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
      const git = (...args: string[]) => execFileSync("git", args, { cwd: env.dir });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "test@example.com");
      git("config", "user.name", "Test");
      execFileSync("sh", ["-c", "echo hi > README.md"], { cwd: env.dir });
      git("add", "-A");
      git("commit", "-qm", "init");
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("runs the subagent inside a workmux-created worktree", async () => {
      const id = uniqueId();
      const handle = `wt-${id}`;
      const markerFile = `/tmp/pi-integ-wt-${id}.txt`;
      trackTempFile(env, markerFile);

      const surface = createTrackedSurface(env, `wt-${id}`);
      await sleep(1000);

      const task = [
        `Call the subagent tool ONCE with these EXACT parameters:`,
        `  name: "${handle}"`,
        `  agent: "test-echo"`,
        `  worktree: true`,
        // test-echo.md pins haiku; override so the test uses whatever provider
        // the host is actually authenticated for.
        `  model: ${JSON.stringify(TEST_MODEL)}`,
        `  task: "Run this bash command: printf '%s %s' \\"$(pwd)\\" \\"$(git rev-parse --abbrev-ref HEAD)\\" > '${markerFile}'"`,
        `Do not do anything else. Just call the subagent tool once.`,
        `After you receive the subagent result, say INTEGRATION_WORKTREE_COMPLETE.`,
      ].join("\n");

      startPi(surface, env.dir, task);

      const content = await waitForFile(markerFile, PI_TIMEOUT);
      const [cwd, branch] = content.trim().split(/\s+/);

      assert.ok(
        cwd.includes("__worktrees") && cwd.endsWith(handle),
        `subagent should run in a worktree dir ending with "${handle}", got cwd="${cwd}"`,
      );
      assert.equal(branch, handle, `subagent should be on branch "${handle}", got "${branch}"`);
      assert.ok(existsSync(cwd + "/README.md"), "worktree should contain the repo files");

      await waitForScreen(surface, /INTEGRATION_WORKTREE_COMPLETE|Sub-agent.*"wt-/i, PI_TIMEOUT);

      // Clean up the worktree the spawn created (sibling of env.dir, so
      // cleanupTestEnv would not remove it).
      try {
        execFileSync("workmux", ["remove", handle, "-f"], { cwd: env.dir, stdio: "ignore" });
      } catch {}
      rmSync(env.dir + "__worktrees", { recursive: true, force: true });
    });
  });
}
