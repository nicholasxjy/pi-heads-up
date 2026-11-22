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

After six completed model rounds with tool results in a task, the extension can start one additional request alongside Pi’s next main model request. It uses the current model and its configured authentication. For a virtual model, it uses the physical model from the completed round. It pauses checks while another check is in flight or a note is open. The request has no tools, runs in the background, and counts toward the model’s usage or billing. Print, JSON, and RPC sessions skip the feature.

The review request includes up to 20,000 characters of recent conversation, tool calls, and tool results, plus up to 50 recent notes. It takes the transcript after Pi runs its `context` hooks. Use that hook for redaction you want the review to inherit. The extension stores the enabled setting and note topics, titles, and known status in `~/.pi/agent/pi-heads-up/state.sqlite` (relative to `PI_CODING_AGENT_DIR` when set). Note records expire after 30 days and are cleaned up at startup or on the next check. With `--no-session`, the extension uses an in-memory note history for that session.

## Test

```sh
npm install --no-package-lock
npm test
```
