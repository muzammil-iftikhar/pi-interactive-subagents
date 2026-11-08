/**
 * herdr surface layer — subagent panes in the Herdr terminal app.
 *
 * Herdr splits the work in two: `herdr-app` changes what the person sees
 * (pane.split / pane.focus / pane.close), and `hc` runs and talks to the
 * terminals themselves (send / read / kill). Both are needed here, so this
 * module is the herdr counterpart of tmux.ts and exposes the same API.
 *
 * Terminals are identified by their herdr address (e.g. `t19`), not a pane id,
 * because every screen read and keystroke goes through `hc`.
 *
 * Splits always target the parent pi's pane (`$HC_TERMINAL_ID`), so new panes
 * land beside the agent rather than whatever the person happens to be focused
 * on, and focus is handed back after each split (`pane.focus`) since herdr —
 * unlike `tmux split-window -d` — focuses the new pane.
 */
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  interpretExitSidecar,
  pollForExit as pollForExitShared,
  type PollOptions,
  type PollResult,
} from "./exit-poll.ts";

const execFileAsync = promisify(execFile);

// ── Availability ──

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  try {
    execFileSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" });
    available = true;
  } catch {
    available = false;
  }

  commandAvailability.set(command, available);
  return available;
}

/**
 * True when running inside a Herdr terminal with both herdr binaries on PATH.
 * `HC_TERMINAL_SOCKET` is set by herdr-core in every terminal it starts.
 */
export function isHerdrAvailable(): boolean {
  return (
    !!process.env.HC_TERMINAL_SOCKET &&
    hasCommand("hc") &&
    hasCommand("herdr-app")
  );
}

export function muxSetupHint(): string {
  return "Run pi inside a Herdr terminal (open a pane in the Herdr app and run `pi` there).";
}

function requireHerdr(): void {
  if (!isHerdrAvailable()) {
    throw new Error(`herdr is required for subagents. ${muxSetupHint()}`);
  }
}

// ── Shell helpers ──

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

// ── Herdr helpers ──

/** This pi's terminal address (`t1`), set by herdr-core. */
function parentTerminal(): string | undefined {
  return process.env.HC_TERMINAL_ID?.trim() || undefined;
}

interface HerdrLane {
  terminal?: string;
  pane?: string | null;
}

/**
 * Map a terminal address to the pane that shows it. Returns undefined when the
 * terminal is hidden (no pane) or the window is gone — callers then fall back
 * to herdr's own default (the focused pane).
 */
function resolvePane(terminal: string): string | undefined {
  try {
    const out = execFileSync("herdr-app", ["ls"], { encoding: "utf8" });
    const data = JSON.parse(out) as {
      spaces?: Array<{ tabs?: Array<{ terminals?: HerdrLane[] }> }>;
    };
    for (const space of data.spaces ?? []) {
      for (const tab of space.tabs ?? []) {
        for (const lane of tab.terminals ?? []) {
          if (lane.terminal === terminal && lane.pane) return lane.pane;
        }
      }
    }
  } catch {
    // Window closed or ls failed; focus handling is best-effort.
  }
  return undefined;
}

/** Run a herdr-app command and return its JSON reply. */
function herdrDo(command: string, args: string[]): Record<string, any> {
  const out = execFileSync("herdr-app", ["do", command, ...args], { encoding: "utf8" });
  const text = out.trim();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return {};
  }
}

/** Give the keyboard back to the parent pane after a split. Best-effort. */
function refocusParent(): void {
  const terminal = parentTerminal();
  const pane = terminal ? resolvePane(terminal) : undefined;
  if (!pane) return;
  try {
    herdrDo("pane.focus", ["--pane", pane]);
  } catch {
    // The pane list can shift while panes close; a lost focus is cosmetic.
  }
}

// ── Surface primitives ──

/**
 * Create a new pane for a subagent: a right split off the parent pi's pane,
 * with focus handed back to pi.
 *
 * Returns the new terminal address (e.g. `t19`).
 */
export function createSurface(name: string): string {
  return createSurfaceSplit(name, "right", parentTerminal());
}

/**
 * Create a new split in the given direction from an optional source terminal.
 * Herdr only knows `right` and `down`; left/up fold into them.
 *
 * Returns the new terminal address (e.g. `t19`).
 */
export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  void name;
  requireHerdr();

  const args = ["--direction", direction === "down" || direction === "up" ? "down" : "right"];
  const source = fromSurface
    ? (resolvePane(fromSurface) ?? undefined)
    : (parentTerminal() ? resolvePane(parentTerminal()!) : undefined);
  if (source) args.push("--pane", source);

  const reply = herdrDo("pane.split", args);
  const terminal = typeof reply.terminal === "string" ? reply.terminal : "";
  if (!terminal) {
    throw new Error(
      `Unexpected herdr pane.split reply: ${JSON.stringify(reply)}`,
    );
  }

  refocusParent();
  return terminal;
}

/**
 * Send a command string to a terminal and execute it.
 * `hc send` pastes the text and presses Enter, so literal strings are safe.
 */
export function sendCommand(surface: string, command: string): void {
  requireHerdr();
  execFileSync("hc", ["send", surface, command], { encoding: "utf8" });
}

/**
 * Send a long command to a pane by writing it to a script file first.
 * Kept from the tmux layer: a launch command is far wider than a pane, and
 * typing it directly risks the shell mangling wrapped lines.
 *
 * By default the script is written to a temp directory, but callers can pass a
 * stable path (for example under session artifacts) so the exact invocation is
 * preserved for debugging.
 *
 * Returns the script path.
 */
export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  const scriptPath =
    options?.scriptPath ??
    join(
      tmpdir(),
      "pi-subagent-scripts",
      `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`,
    );
  mkdirSync(dirname(scriptPath), { recursive: true });

  const scriptParts = ["#!/bin/bash"];
  if (options?.scriptPreamble) {
    scriptParts.push(options.scriptPreamble.trimEnd());
  }
  scriptParts.push(command);

  writeFileSync(scriptPath, scriptParts.join("\n") + "\n", {
    mode: 0o755,
  });
  sendCommand(surface, `bash ${shellEscape(scriptPath)}`);
  return scriptPath;
}

/**
 * Read the screen contents of a terminal (sync).
 */
export function readScreen(surface: string, lines = 50): string {
  requireHerdr();
  return execFileSync(
    "hc",
    ["read", surface, "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
}

/**
 * Read the screen contents of a terminal (async).
 */
export async function readScreenAsync(surface: string, lines = 50): Promise<string> {
  requireHerdr();
  const { stdout } = await execFileAsync(
    "hc",
    ["read", surface, "--lines", String(Math.max(1, lines))],
    { encoding: "utf8" },
  );
  return stdout;
}

/**
 * Close a terminal, which takes its pane with it. A terminal that already
 * exited has no pane left, so the error is swallowed: closing a dead surface
 * is a no-op by intent.
 */
export function closeSurface(surface: string): void {
  requireHerdr();
  try {
    execFileSync("hc", ["kill", surface], { encoding: "utf8", stdio: "pipe" });
  } catch {
    try {
      execFileSync("hc", ["rm", surface], { encoding: "utf8", stdio: "pipe" });
    } catch {
      // Already gone.
    }
  }
}

// ── Exit polling ──

/**
 * Poll until the subagent exits. The loop itself is backend-agnostic
 * (exit-poll.ts); this wrapper supplies herdr's screen reader.
 */
export function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollOptions,
): Promise<PollResult> {
  return pollForExitShared(surface, signal, { ...options, readScreen: readScreenAsync });
}

export const __pollForExitTest__ = { interpretExitSidecar };
