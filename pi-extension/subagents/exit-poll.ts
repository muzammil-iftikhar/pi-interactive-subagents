/**
 * Backend-agnostic exit polling for subagent surfaces.
 *
 * The loop only needs two things from a multiplexer: a `.exit` sidecar check
 * (files) and a way to read the last lines of a surface (for the
 * `__SUBAGENT_DONE_<code>__` sentinel). The screen reader is injected so this
 * file works with tmux (`capture-pane`) and herdr (`hc read`) alike.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";

export interface PollResult {
  /** How the subagent exited */
  reason: "done" | "sentinel" | "error" | "hung";
  /** Shell exit code (from sentinel). 0 for file-based exits. */
  exitCode: number;
  /** Error message if reason is "error" (auto-retry exhausted, provider overload, etc.) */
  errorMessage?: string;
}

export interface PollOptions {
  interval: number;
  sessionFile?: string;
  sentinelFile?: string;
  /** True when the child reported itself finished but never exited. */
  hungAfterDone?: () => boolean;
  onTick?: (elapsed: number) => void;
}

/**
 * Reads the bottom `lines` lines of a surface. Backend supplies it.
 */
export type ScreenReader = (surface: string, lines: number) => Promise<string>;

/**
 * Interpret an `.exit` sidecar payload (written by the error path in
 * subagent-done.ts). Centralized so both the fast and slow paths in
 * pollForExit decode the payload the same way. Clean completions write no
 * sidecar and are detected via the terminal sentinel instead.
 *
 * Note: ask_question does NOT write a `.exit` sidecar — it keeps the session
 * open and signals the parent via a separate `.ask` file (see deliverPendingQuestion).
 */
export function interpretExitSidecar(data: any): PollResult {
  if (data?.type === "error") {
    const errorMessage =
      typeof data.errorMessage === "string" && data.errorMessage.trim() !== ""
        ? data.errorMessage
        : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
    return { reason: "error", exitCode: 1, errorMessage };
  }
  return { reason: "done", exitCode: 0 };
}

/**
 * Poll until the subagent exits. Checks for a `.exit` sidecar file first
 * (written by the error path), falling back to the terminal sentinel for
 * clean-completion and crash detection.
 */
export async function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollOptions & { readScreen: ScreenReader },
): Promise<PollResult> {
  const start = Date.now();
  const { readScreen, ...rest } = options;

  for (;;) {
    if (signal.aborted) {
      throw new Error("Aborted while waiting for subagent to finish");
    }

    // Fast path: check for .exit sidecar file (written by the error path)
    if (rest.sessionFile) {
      try {
        const exitFile = `${rest.sessionFile}.exit`;
        if (existsSync(exitFile)) {
          const data = JSON.parse(readFileSync(exitFile, "utf-8"));
          rmSync(exitFile, { force: true });
          return interpretExitSidecar(data);
        }
      } catch {}
    }

    // Watchdog: a child that reported itself done but never exited leaves the
    // shell wrapper waiting, so the done marker never reaches the screen and
    // this loop would wait forever. Take the completed turn instead.
    if (rest.hungAfterDone?.()) {
      return { reason: "hung", exitCode: 0 };
    }

    // Check Claude sentinel file (written by plugin Stop hook)
    if (rest.sentinelFile) {
      try {
        if (existsSync(rest.sentinelFile)) {
          return { reason: "sentinel", exitCode: 0 };
        }
      } catch {}
    }

    // Slow path: read terminal screen for sentinel (crash detection)
    try {
      const screen = await readScreen(surface, 5);
      const match = screen.match(/__SUBAGENT_DONE_(\d+)__/);
      if (match) {
        return { reason: "sentinel", exitCode: parseInt(match[1], 10) };
      }
    } catch {
      // Surface may have been destroyed — check if .exit file appeared in the meantime
      if (rest.sessionFile) {
        try {
          const exitFile = `${rest.sessionFile}.exit`;
          if (existsSync(exitFile)) {
            const data = JSON.parse(readFileSync(exitFile, "utf-8"));
            rmSync(exitFile, { force: true });
            return interpretExitSidecar(data);
          }
        } catch {}
      }
    }

    const elapsed = Math.floor((Date.now() - start) / 1000);
    rest.onTick?.(elapsed);

    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(new Error("Aborted"));
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, rest.interval);
      function onAbort() {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
