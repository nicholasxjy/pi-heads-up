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

Suggestions are on by default in Pi’s terminal UI. Run `/heads-up off` to disable them across sessions or `/heads-up on` to turn them back on. When there’s no note, `/heads-up` opens the setting.

When there is a note, **Learn more** opens the explanation. **Knew this already** and **Understood** record the topic as known. **Dismiss** closes the note. **Chat in main session** quotes the note in the Pi editor for you to edit and submit. Pi’s usual editor and keys handle every action.

## Review behavior and data

After six completed model rounds with tool results in a task, the extension can review the work alongside Pi’s next main request. If a task finishes normally with at least three tool results and no earlier review, it can run one closing check. Three results from parallel calls in a single round qualify. Queued input, an open note, or a review in flight suppresses the closing check. Starting a new task clears the previous preview and keeps the editor draft and note history.

Reviews use the current model and its configured authentication. For a virtual model, the review uses the physical model from the completed round. Each request runs in the background without tools and counts toward model usage or billing. Reviews run only in Pi’s terminal UI.

Both checks use up to 20,000 characters from the conversation after Pi’s `context` hooks, plus up to 50 recent notes for the current project. The closing check uses the last filtered model input. Pi 1.6.0 exposes the final reply before a further filter pass, so the extension leaves that reply out. An oversized failed tool result keeps its beginning and final diagnostic within the 3,000-character message budget.

The extension stores the global enabled setting and per-project note topics, titles, and known status in `~/.pi/agent/pi-heads-up/state.sqlite` (relative to `PI_CODING_AGENT_DIR` when set). Each Pi working directory has its own history. Note records expire after 30 days and are cleaned up at startup or on the next check. Records written by older versions have no project and expire without entering a review. With `--no-session`, the extension uses an in-memory note history for that session.

## Test

```sh
npm install --no-package-lock
npm test
```
