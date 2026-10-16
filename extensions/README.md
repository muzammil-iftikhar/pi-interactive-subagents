# pi-tmux-status

A standalone pi extension that shows whether the agent is busy in the tmux window
list — independent of workmux, and works with or without git worktrees.

One badge per **window**, written by the parent pi process as a tmux window option
named `@pi_status`. Values are the state words `working`, `waiting`, `done`; unset
means idle. The state-to-glyph mapping lives in `tmux.conf`, not in the extension.

| state | meaning | default glyph |
| --- | --- | --- |
| `working` | the agent is running a turn, or a spawned subagent is still busy | cog `U+F085` |
| `waiting` | a subagent is parked on a question and needs an answer | hourglass `U+F252` |
| `done` | the turn finished and nothing is running | check `U+F00C` |

`waiting` outranks `working`; `done` only appears once every subagent is finished.
`working` and `waiting` stay until the state itself changes, so a glance at the
window never acknowledges a subagent that still needs an answer. `done` clears
when the window is selected or focused, and fades after 5s if it is on screen.

Subagents run as extra panes in the same window and their children launch with
extensions disabled, so the badge is always aggregate and always written by the
parent process. Nesting is guarded: a window is owned by the first live pi pid
(`@pi_status_owner`), and a nested `pi --print` neither claims nor clears it.

## Install

1. Copy `pi-tmux-status.ts` to `~/.pi/agent/extensions/` (pi auto-loads that dir).
2. Add the badge to the window list format and the two clear hooks to `~/.tmux.conf`.
3. `tmux source-file ~/.tmux.conf`.

```tmux
# state -> glyph: working=cog U+F085, waiting=hourglass U+F252, done=check U+F00C
set -g @tmux2k-window-list-format '#I:#W #{?@pi_status,#{?#{==:#{@pi_status},waiting},,#{?#{==:#{@pi_status},done},,}},}'
# done clears when the window is selected or a pane is focused; working stays, and
# waiting stays too - a subagent needs an answer, so it must survive a glance.
# pane-focus-in alone is not enough: tmux 3.4 does not fire it on window switches.
# pane-focus-in alone is not enough: tmux 3.4 does not fire it on window switches.
set-hook -g pane-focus-in 'if-shell -F "#{==:#{@pi_status},done}" "set-option -uw @pi_status"'
```

The `@tmux2k-window-list-format` line is for a tmux2k status bar, which rewrites
`window-status-format` asynchronously at load — appending `set -g
window-status-format` instead would be clobbered. Insert the badge into whatever
format your status bar uses if it is not tmux2k. Glyphs need a Nerd Font.

Requires the subagent tooling from this repo for the `suba:activity` aggregate;
without it the badge still tracks the main session.
