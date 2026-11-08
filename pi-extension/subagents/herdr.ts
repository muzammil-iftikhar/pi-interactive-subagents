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
 * unlike `tmux split-window -d` — focuses the new pane. Focus returns to the
 * pane that was focused before the split, so someone viewing another space is
 * left there instead of being switched back to pi's space.
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

/** Every lane herdr knows about, in space/tab order. Empty when ls fails. */
function listLanes(): HerdrLane[][] {
  try {
    const out = execFileSync("herdr-app", ["ls"], { encoding: "utf8" });
    const data = JSON.parse(out) as {
      spaces?: Array<{ tabs?: Array<{ terminals?: HerdrLane[] }> }>;
    };
    const tabs: HerdrLane[][] = [];
    for (const space of data.spaces ?? []) {
      for (const tab of space.tabs ?? []) {
        tabs.push(tab.terminals ?? []);
      }
    }
    return tabs;
  } catch {
    // Window closed or ls failed; focus handling is best-effort.
    return [];
  }
}

/**
 * Map a terminal address to the pane that shows it. Returns undefined when the
 * terminal is hidden (no pane) or the window is gone — callers then fall back
 * to herdr's own default (the focused pane).
 */
function resolvePane(terminal: string): string | undefined {
  for (const lanes of listLanes()) {
    for (const lane of lanes) {
      if (lane.terminal === terminal && lane.pane) return lane.pane;
    }
  }
  return undefined;
}

/** Panes sharing a terminal's tab, in layout order. */
function tabPanes(terminal: string | undefined): string[] {
  if (!terminal) return [];
  for (const lanes of listLanes()) {
    if (!lanes.some((lane) => lane.terminal === terminal)) continue;
    return lanes.flatMap((lane) => (lane.pane ? [lane.pane] : []));
  }
  return [];
}

/**
 * Make every pane in a tab the same width.
 *
 * herdr gives a new split all the space left over instead of half of its
 * source pane, so two subagents beside pi end up 415px / 395px / 815px. An
 * equal weight on each pane restores an even split, and because the weights
 * are relative, closing a pane afterwards stays even on its own.
 */
function evenPanes(terminal: string | undefined): void {
  for (const pane of tabPanes(terminal)) {
    try {
      herdrDo("layout.resize", ["--id", pane, "--weight", "1"]);
    } catch {
      // A pane can vanish between the listing and the resize; cosmetic.
    }
  }
}

/**
 * Wait until a killed terminal's pane is gone, so re-evening sees the real
 * layout. Bounded, so a stuck pane never hangs a close.
 */
function waitForPaneGone(terminal: string, timeoutMs = 1500): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!resolvePane(terminal)) return;
    try {
      execFileSync("sleep", ["0.05"]);
    } catch {
      return;
    }
  }
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

/**
 * The pane herdr is currently showing, or undefined when status is unavailable.
 *
 * herdr displays exactly one space at a time, so focusing a pane is also what
 * selects a space: this is how we hand the view back after a split.
 */
function focusedPane(): string | undefined {
  try {
    const out = execFileSync("herdr-app", ["status"], { encoding: "utf8" });
    const data = JSON.parse(out) as { focused_pane?: string };
    return typeof data.focused_pane === "string" ? data.focused_pane : undefined;
  } catch {
    // Window closed or status failed; focus handling is best-effort.
    return undefined;
  }
}

/** Focus a pane, best-effort. Focusing a pane also shows the space it lives in. */
function focusPane(pane: string): void {
  try {
    herdrDo("pane.focus", ["--pane", pane]);
  } catch {
    // The pane list can shift while panes close; a lost focus is cosmetic.
  }
}

/** Give the keyboard back to the parent pane after a split. Best-effort. */
function refocusParent(): void {
  const terminal = parentTerminal();
  const pane = terminal ? resolvePane(terminal) : undefined;
  if (pane) focusPane(pane);
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

  // Remember what the person was looking at before the split. herdr focuses the
  // new pane and shows the space it lands in, so restoring this pane afterwards
  // returns them to their own space instead of yanking them back to pi's.
  const previousPane = focusedPane();

  const reply = herdrDo("pane.split", args);
  const terminal = typeof reply.terminal === "string" ? reply.terminal : "";
  if (!terminal) {
    throw new Error(
      `Unexpected herdr pane.split reply: ${JSON.stringify(reply)}`,
    );
  }

  if (previousPane) focusPane(previousPane);
  else refocusParent();
  evenPanes(terminal);
  return terminal;
}

/**
 * Herdr terminal names are 1-32 of a-z 0-9 - _ ; anything else is rejected.
 */
function hcName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "subagent";
}

/** Wait until a terminal has a pane, asking herdr again while it settles. */
function waitForPane(terminal: string, timeoutMs = 1500): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (resolvePane(terminal)) return;
    try {
      // `hc run --bg` reports the address before the core has registered the
      // terminal, so the first keep can fail with "no running terminal".
      herdrDo("terminal.keep", ["--terminal", terminal, "--place", "right"]);
    } catch {
      // Not registered yet; try again on the next turn of the loop.
    }
    try {
      execFileSync("sleep", ["0.1"]);
    } catch {
      return;
    }
  }
}

/** One `hc` run, retrying without a name when that name is already taken. */
function hcRun(address: { args: string[] }): string {
  const parse = (out: string): string => {
    try {
      const reply = JSON.parse(out) as { address?: string };
      return typeof reply.address === "string" ? reply.address : "";
    } catch {
      return "";
    }
  };

  try {
    return parse(execFileSync("hc", address.args, { encoding: "utf8" }));
  } catch {
    const args: string[] = [];
    for (let i = 0; i < address.args.length; i += 1) {
      if (address.args[i] === "--name") {
        i += 1;
        continue;
      }
      args.push(address.args[i]!);
    }
    return parse(execFileSync("hc", args, { encoding: "utf8" }));
  }
}

/**
 * Create a pane for a subagent that herdr files under the parent agent.
 *
 * Herdr only nests a child when its terminal records a parent, and only
 * `hc run --parent` writes that link: a plain `pane.split` makes a
 * free-standing terminal that herdr lists as another top-level agent. The
 * terminal starts pane-less (herdr's own idea of a sub-agent), so
 * `terminal.keep` gives it the pane beside pi.
 */
export function createNestedSurface(name: string, cwd?: string): string {
  requireHerdr();

  const args = ["run", "--bg", "--name", hcName(name)];
  const parent = parentTerminal();
  if (parent) args.push("--parent", parent);
  if (cwd) args.push("--cwd", cwd);
  args.push(process.env.SHELL?.trim() || "bash");

  const terminal = hcRun({ args });
  if (!terminal) {
    throw new Error("hc run did not report a terminal address");
  }

  // Give it the pane beside pi; keep races terminal registration, so the retry
  // lives inside waitForPane instead of being fired once here.
  waitForPane(terminal);
  evenPanes(terminal);
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

  // The pane goes away a moment after the terminal does; re-spread what is left
  // once it has, so the remaining panes stay even.
  waitForPaneGone(surface);
  evenPanes(parentTerminal());
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
