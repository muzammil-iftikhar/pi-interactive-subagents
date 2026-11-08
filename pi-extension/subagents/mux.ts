/**
 * Multiplexer selection — the one module index.ts imports.
 *
 * Two backends expose the same surface API:
 *   - herdr.ts  (Herdr terminal app: `herdr-app` for panes, `hc` for terminals)
 *   - tmux.ts   (tmux panes, the original backend)
 *
 * Herdr wins when pi runs inside a Herdr terminal (`HC_TERMINAL_SOCKET` is
 * set), because a herdr terminal also sits inside whatever tmux session
 * started it; falling through to tmux there would put subagents in tmux panes
 * the person never looks at. Override per spawn with
 * `PI_SUBAGENT_MUX=herdr|tmux`.
 */
import * as herdr from "./herdr.ts";
import * as tmux from "./tmux.ts";
import type { PollOptions, PollResult } from "./exit-poll.ts";

type Backend = typeof herdr;

function forcedBackend(): "herdr" | "tmux" | null {
  const raw = process.env.PI_SUBAGENT_MUX?.trim().toLowerCase();
  return raw === "herdr" || raw === "tmux" ? raw : null;
}

/** The backend to use right now. Resolved per call so an env change takes effect. */
export function currentMux(): "herdr" | "tmux" | null {
  const forced = forcedBackend();
  if (forced === "herdr") return herdr.isHerdrAvailable() ? "herdr" : null;
  if (forced === "tmux") return tmux.isTmuxAvailable() ? "tmux" : null;
  if (herdr.isHerdrAvailable()) return "herdr";
  if (tmux.isTmuxAvailable()) return "tmux";
  return null;
}

function backend(): Backend {
  return currentMux() === "tmux" ? (tmux as unknown as Backend) : herdr;
}

export function isMuxAvailable(): boolean {
  return currentMux() !== null;
}

export function muxSetupHint(): string {
  return forcedBackend() === "tmux" ? tmux.muxSetupHint() : herdr.muxSetupHint();
}

/** Name of the active multiplexer, for error messages and status text. */
export function muxName(): string {
  return currentMux() ?? "none";
}

export function createSurface(name: string): string {
  return backend().createSurface(name);
}

/**
 * Create a surface herdr files under the parent agent, for runs that live in
 * their own worktree. A plain pane split is enough for every other run: those
 * show up as their own agent, which is what a short interactive helper should
 * do. Backends without a parent concept fall back to a plain surface.
 */
export function createNestedSurface(name: string, cwd?: string): string {
  return currentMux() === "herdr"
    ? herdr.createNestedSurface(name, cwd)
    : tmux.createSurface(name);
}

export function createSurfaceSplit(
  name: string,
  direction: "left" | "right" | "up" | "down",
  fromSurface?: string,
): string {
  return backend().createSurfaceSplit(name, direction, fromSurface);
}

export function sendCommand(surface: string, command: string): void {
  backend().sendCommand(surface, command);
}

export function sendLongCommand(
  surface: string,
  command: string,
  options?: { scriptPath?: string; scriptPreamble?: string },
): string {
  return backend().sendLongCommand(surface, command, options);
}

export function readScreen(surface: string, lines = 50): string {
  return backend().readScreen(surface, lines);
}

export function readScreenAsync(surface: string, lines = 50): Promise<string> {
  return backend().readScreenAsync(surface, lines);
}

export function closeSurface(surface: string): void {
  backend().closeSurface(surface);
}

export function pollForExit(
  surface: string,
  signal: AbortSignal,
  options: PollOptions,
): Promise<PollResult> {
  return currentMux() === "tmux"
    ? tmux.pollForExit(surface, signal, options)
    : herdr.pollForExit(surface, signal, options);
}

export { shellEscape } from "./tmux.ts";
