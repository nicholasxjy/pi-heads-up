# pi-heads-up

A Pi extension inspired by Claude Code’s You should know feature. During a long tool-using task, a separate model request can surface an overlooked decision, surprising result, or idea that changes how you understand the work. [Claude Code reference](https://code.claude.com/docs/en/interactive-mode#you-should-know-suggestions)

## Install

Requires Pi 1.6.0 or newer and Node.js 22.19 or newer. From this checkout, run:

```sh
pi install "$PWD"
```

To try it for one Pi invocation, run `pi -e ./src/index.ts` from the checkout.

## Use

Suggestions appear above the input with a **Heads up** or **You should know** label. The preview shows up to three lines of the title. Run `/heads-up` to read the full title and open the note’s actions.

Suggestions are on by default in Pi’s terminal UI. Available `/heads-up` subcommands (with argument completion):

- `/heads-up` — open the active note, or when none is visible, toggle suggestions, check status, pick a review model, or browse project history
- `/heads-up on` / `/heads-up off` — enable or disable suggestions across sessions
- `/heads-up status` — show enabled state, active review model, project note counts, and the last review outcome/error
- `/heads-up model [provider/id | auto]` — select a dedicated review model or reset to follow the session model
- `/heads-up history` — inspect recorded project notes, toggle known/unseen status, or delete entries
- `/heads-up clear` — clear recorded note history for the current project (with confirmation)

When reviewing a note, **Learn more** opens the explanation. **Knew this already** and **Understood** record the topic as known. **Dismiss** closes the note. **Chat in main session** quotes the note in the Pi editor for you to edit and submit. Pi’s usual editor and keys handle every action.

## Review behavior and data

After six completed model rounds with tool results in a task, the extension can review the work alongside Pi’s next main request. If a task finishes normally with at least three tool results since the last completed review, it runs one closing check. Three results from parallel calls in a single round qualify. Queued input, an open note, or a review in flight suppresses the closing check. A failed or timed-out mid-task review does not suppress the closing check. Starting a new task clears the previous preview and keeps the editor draft and note history.

By default, reviews use the current session model and its configured authentication (or the physical model from the completed round for virtual models). You can override this per installation with `/heads-up model`. Requests run in the background without tools via `streamSimple` (`cacheRetention: "none"`, up to 800 output tokens or 2,048 on reasoning models with minimal thinking when thinking cannot be turned off) and count toward model usage or billing. Reviews run only in Pi’s terminal UI.

Both checks use up to 20,000 characters from the conversation after Pi’s `context` hooks, plus up to 4,000 characters (up to 50 entries) of recent notes for the current project. The closing check appends the final assistant reply (up to 3,000 characters) to the last filtered model input; because Pi 1.6.0 exposes the final reply before a further `context` filter pass, only earlier messages have passed through `context` hooks. An oversized failed tool result keeps its beginning and final diagnostic within the 3,000-character message budget.

The extension stores the global enabled setting, optional custom review model, and per-project note topics, titles, and known status in `~/.pi/agent/pi-heads-up/state.sqlite` (relative to `PI_CODING_AGENT_DIR` when set) using SQLite WAL mode. Project history is keyed by `realpath(cwd)` so symlink aliases share history while distinct directories stay isolated. Note records expire after 30 days and are cleaned up at startup or when new notes are stored. Legacy unscoped note tables expire without entering a review and are dropped once empty. With `--no-session`, the extension uses an in-memory note history for that session.

## Test & Typecheck

```sh
npm install --no-package-lock
npm run typecheck
npm test
```
