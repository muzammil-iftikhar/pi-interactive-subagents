/**
 * pi agent status badge in the tmux window list.
 *
 * Writes two window options on the window holding $TMUX_PANE:
 *   @pi_status        working | waiting | done (tmux.conf maps it to a glyph and
 *                     clears the dismissible states when you focus the window)
 *   @pi_status_owner  pid of the owning pi, so a nested `pi --print` in the same
 *                     window stays quiet instead of fighting the outer session
 *
 * One option on purpose: a glyph plus a separate state option allowed the focus
 * hook to fire between the two writes and leave the badge out of sync with its
 * state. With a single write that race cannot happen.
 *
 * Load-time work (subscribe, claim) is deliberate: /reload swaps the code without
 * re-firing session_start, so anything that happened only on session_start would
 * leave the reloaded instance inert until the next fresh pi process.
 *
 * No workmux, no state files, no sidebar.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const OPT_STATUS = "@pi_status";
const OPT_OWNER = "@pi_status_owner";

/** How often to re-check a pane owned by someone else, in ms. */
const CLAIM_RETRY_MS = 2000;

/** How long a finished tick stays before fading, in ms. */
const DONE_EXPIRY_MS = 5000;

type StatusState = "working" | "waiting" | "done";
type Display = StatusState | "idle";

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export default function (pi: ExtensionAPI) {
	const pane = process.env.TMUX_PANE;
	if (!pane) return; // not inside tmux: nothing to draw on

	let owns = false;
	let stopped = false;
	let parentWorking = false;
	let uiWaiting = false;
	let finished = false;
	let activeCount: number | undefined;
	let waitingCount: number | undefined;
	/** Last state we actually wrote, so a focus-hook clear is not undone. */
	let shown: Display | undefined;
	let lastClaimAttempt = 0;
	/** Event callbacks are not awaited by pi; an older write must not land last. */
	let writes: Promise<unknown> = Promise.resolve();
	/** Pending fade for the finished tick. */
	let doneExpiry: ReturnType<typeof setTimeout> | undefined;

	async function tmuxOut(args: string[]): Promise<string | undefined> {
		try {
			const result = await pi.exec("tmux", args);
			return result.code === 0 ? result.stdout.trim() : undefined;
		} catch {
			return undefined; // tmux unreachable: the badge is cosmetic, never fatal
		}
	}

	async function getOption(name: string): Promise<string | undefined> {
		return tmuxOut(["show-options", "-w", "-t", pane, "-v", name]);
	}

	async function setOption(name: string, value: string): Promise<void> {
		try {
			await pi.exec("tmux", ["set-option", "-w", "-t", pane, name, value]);
		} catch {
			// ignore
		}
	}

	async function unsetOption(name: string): Promise<void> {
		try {
			await pi.exec("tmux", ["set-option", "-w", "-u", "-t", pane, name]);
		} catch {
			// ignore
		}
	}

	function isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
		// shortcut: pid-only ownership, upgrade to a pid+start-time token if a recycled
		// pid ever silences a window
	}

	/** Own the pane's window unless a live pi already does. */
	async function claim(): Promise<void> {
		lastClaimAttempt = Date.now();
		const owner = await getOption(OPT_OWNER);
		const ownerPid = Number(owner);
		if (owner && ownerPid !== process.pid && isAlive(ownerPid)) {
			owns = false;
			return;
		}
		await setOption(OPT_OWNER, String(process.pid));
		owns = true;
	}

	function computeState(): Display {
		// A blocked child needs the user as much as a blocked parent does.
		if (uiWaiting || (waitingCount ?? 0) > 0) return "waiting";
		if (parentWorking || (activeCount ?? 0) > 0) return "working";
		return finished ? "done" : "idle";
	}

	function cancelExpiry(): void {
		if (doneExpiry) {
			clearTimeout(doneExpiry);
			doneExpiry = undefined;
		}
	}

	/**
	 * Fade a finished tick after a few seconds, but only while the window is in
	 * front of a client. If you are elsewhere, the tick waits for you and the
	 * focus hook clears it when you arrive.
	 */
	async function expireDone(): Promise<void> {
		doneExpiry = undefined;
		if (stopped || !owns) return;
		const visibility = await tmuxOut([
			"display-message",
			"-p",
			"-t",
			pane,
			"-F",
			"#{?#{&&:#{window_active},#{session_attached}},visible,hidden}",
		]);
		if (visibility !== "visible") return;
		if (computeState() !== "done") return;
		shown = "idle";
		await unsetOption(OPT_STATUS);
	}

	async function write(state: Display): Promise<void> {
		if (state === "idle") {
			await unsetOption(OPT_STATUS);
			return;
		}
		await setOption(OPT_STATUS, state);
	}

	async function refresh(): Promise<void> {
		if (stopped) return;
		if (!owns && Date.now() - lastClaimAttempt > CLAIM_RETRY_MS) {
			await claim();
		}
		const state = computeState();
		if (!owns || state === shown) return;
		shown = state;
		cancelExpiry();
		if (state === "done") {
			doneExpiry = setTimeout(() => void expireDone(), DONE_EXPIRY_MS);
		}
		writes = writes.then(() => write(state));
		await writes;
	}

	/** Clear the badge when this session ends, then stay quiet. */
	async function release(): Promise<void> {
		stopped = true;
		cancelExpiry();
		const hadOwnership = owns;
		owns = false;
		// A session that never owned the pane (a nested `pi --print` behind a live
		// owner) must not clear someone else's badge on its way out.
		if (!hadOwnership) return;
		await writes;
		await unsetOption(OPT_STATUS);
		await unsetOption(OPT_OWNER);
	}

	// Subscribed at load so a reloaded session still tracks its children.
	pi.events.on("suba:activity", (data: unknown) => {
		if (stopped || !data || typeof data !== "object") return;
		const { activeCount: active, waitingCount: waiting } = data as {
			activeCount?: unknown;
			waitingCount?: unknown;
		};
		if (!isCount(active)) return;
		activeCount = active;
		if (isCount(waiting)) waitingCount = waiting;
		void refresh();
	});

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		stopped = false;
		activeCount = undefined;
		waitingCount = undefined;
		uiWaiting = false;
		finished = false;
		parentWorking = !ctx.isIdle();
		shown = undefined;
		lastClaimAttempt = 0;

		await claim();
		if (!owns) return;

		// An icon left behind by a pi that was killed must not outlive it.
		await unsetOption(OPT_STATUS);

		// Children that survived a parent reload are restored before we subscribe.
		pi.events.emit("suba:activity:request", {});
		await refresh();
	});

	pi.on("agent_start", async () => {
		if (stopped) return;
		parentWorking = true;
		finished = false;
		await refresh();
	});

	pi.on("agent_settled", async () => {
		if (stopped) return;
		// The turn is over. A child that is still running keeps the badge at
		// "working" through the activeCount branch; isIdle() is not reliable here.
		parentWorking = false;
		finished = true;
		await refresh();
	});

	// Pi is blocked on a user-facing prompt (ask_user_question, confirm, ...).
	pi.on("ui_prompt_start", async () => {
		if (stopped) return;
		uiWaiting = true;
		await refresh();
	});

	pi.on("ui_prompt_end", async () => {
		if (stopped) return;
		uiWaiting = false;
		await refresh();
	});

	pi.on("session_shutdown", async () => {
		await release();
	});
}
