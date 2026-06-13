# pi-node-inspect

Pi extension for attaching to a running Node.js process started with `--inspect` or `--inspect-brk` and surfacing:

- `console.*` output via `Runtime.consoleAPICalled`
- uncaught exceptions via `Runtime.exceptionThrown`
- pause / breakpoint state via `Debugger.paused` and `Debugger.resumed`

This is for the **Node.js Inspector Protocol / Chrome DevTools Protocol**, not browser DOM inspection.

## Install locally

Place this extension under your repo at:

```text
.pi/extensions/pi-node-inspect/
```

Then reload Pi extensions if needed.

## Run a target

```bash
node --inspect-brk=127.0.0.1:9229 path/to/app.js
```

## Start Pi with auto-attach

```bash
pi --inspect-attach --inspect-host 127.0.0.1 --inspect-port 9229
```

Or attach from inside Pi:

```text
/inspect-attach 127.0.0.1:9229
```

## Commands

- `/inspect-attach [host:port]`
- `/inspect-detach`
- `/inspect-status`
- `/inspect-logs [count]`
- `/inspect-bp <file>` — open read-only source viewer in TUI and toggle/clear breakpoints
- `/inspect-bp <file:line> [condition]` — for `.ts` source files, auto source-map to runtime JS and toggle there; for runtime files, set directly
- `/inspect-bp-list`
- `/inspect-scripts [contains-text]`
- `/inspect-bp-clear <id|file:line|all>`
- `/inspect-resume`
- `/inspect-step <over|in|out>`
- `/inspect-eval <expression>`

## Agent tools

- `inspector_status`
- `inspector_recent_logs`
- `inspector_get_pause`
- `inspector_scripts`
- `inspector_set_breakpoint`
- `inspector_remove_breakpoint`
- `inspector_resume`
- `inspector_step`
- `inspector_eval`

## Config

Global config:

```json
// ~/.pi/agent/pi-node-inspector.json
{
  "host": "127.0.0.1",
  "port": 9229,
  "bufferSize": 500,
  "autoInjectPauseEvents": false,
  "ignoreLevels": ["debug"]
}
```

Optional project override:

```json
// .pi/pi-node-inspector.json
{
  "port": 9230
}
```

Config behavior:
- `autoInjectPauseEvents: true` injects a pause event into the Pi conversation when the debugger pauses.
- `ignoreLevels` filters captured console/exception levels such as `debug`, `log`, `warning`, `error`, `exception`.

## Usage examples

List loaded runtime scripts first if source breakpoints do not bind:

```text
/inspect-scripts product-inventory-sync
```

Open the source viewer and toggle breakpoints on TS lines:

```text
/inspect-bp packages/medusa-connector-framework/src/services/product-inventory-sync.ts
```

Viewer keys:
- `↑↓ home end pgup pgdn` navigate
- `space` / `enter` toggle breakpoint on current line
- `c` clear current line
- `/` start search
- `enter` jump to current search
- `n` / `N` next / previous search match
- `backspace` edit search query
- `esc` exit search mode or close the viewer

Or toggle one source line directly through sourcemaps:

```text
/inspect-bp packages/medusa-connector-framework/src/services/product-inventory-sync.ts:38
```

If a TS source line cannot be mapped to a currently loaded runtime script, the breakpoint is refused.

Set a raw runtime breakpoint, then resume:

```text
/inspect-bp apps/cm-api/src/index.ts:42
/inspect-resume
```

Read recent logs:

```text
/inspect-logs 50
```

UI behavior:
- Pi status shows attach state or current paused location.
- Pi widget shows the current pause location and recent log lines.

Evaluate in the paused context:

```text
/inspect-eval process.pid
```

## Manual end-to-end test recipe

1. Create a small fixture:

```js
// fixtures/inspector-loop.js
console.log("boot", process.pid)
debugger
let i = 0
setInterval(() => {
  i += 1
  console.log("tick", i)
}, 1000)
```

2. Start it with the inspector:

```bash
node --inspect-brk=127.0.0.1:9229 fixtures/inspector-loop.js
```

3. Start Pi and attach:

```bash
pi --inspect-attach --inspect-host 127.0.0.1 --inspect-port 9229
```

4. Verify:
   - `/inspect-status` shows attached and paused at entry.
   - `/inspect-resume` continues execution.
   - `/inspect-logs 10` shows `boot` and `tick` logs.
   - `/inspect-scripts inspector-loop` shows the loaded runtime script path.
   - `/inspect-bp fixtures/inspector-loop.js` opens the read-only source viewer.
   - `/inspect-bp fixtures/inspector-loop.js:2` sets a breakpoint.
   - `/inspect-bp path/to/file.ts:line` toggles a source-mapped breakpoint if the runtime JS is loaded.
   - `/inspect-bp-list` shows whether the breakpoint is bound (`-> file.js:line:col`) or still `unbound`.
   - Hitting the breakpoint updates the Pi status/widget.
   - `/inspect-eval i` returns the paused value.

5. Detach and reattach:

```text
/inspect-detach
/inspect-attach 127.0.0.1:9229
```
