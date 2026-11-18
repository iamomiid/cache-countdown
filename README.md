# Cache Countdown

A Claude Code mod that shows how long the prompt cache stays warm, as a fuse above the prompt. It draws in the terminal and in the Code tab of the Claude Desktop app.

![Cache Countdown in its three states: warm, about to lapse, and cold](assets/thumbnail.png)

Anthropic's prompt cache has two lifetimes, 5 minutes and 1 hour, priced differently. Every request of the main conversation refreshes the entry. Once it lapses, the next request pays to write the whole context to the cache again. This mod shows how long you have left, and what it costs when the time runs out.

## Install

Requires Claude Code v2.1.287 or later.

In a Claude Code session:

```text
/plugin marketplace add iamomiid/cache-countdown
/plugin install cache-countdown@cache-countdown
```

Or from your shell:

```bash
claude plugin marketplace add iamomiid/cache-countdown
```

```bash
claude plugin install cache-countdown@cache-countdown
```

To try it for one session without installing, clone the repository and load the folder:

```bash
claude --plugin-dir ./cache-countdown
```

The band appears after the first reply of a conversation.

A mod runs with your permissions. To see what this one hooks and calls before loading it, run `claude plugin validate` on the cloned folder. It reads the session transcript, runs `tail` on it, and makes model requests only when you press Keep warm or hold the cache.

## What it shows

One row above the prompt. In the Desktop app:

![The Cache Countdown row above the prompt box in the Claude Desktop app](assets/preview.png)

In a terminal:

```text
52m ━━━━━━━━━━━━━━━━━━━━━─── 1h   ctx 212k 21%  │  5h 28% 3h41m  │  wk 36% 4d16h
```

Both images on this page are illustrations drawn to match the app, with example figures.

The row holds:

- **The time left**, then a fuse that shortens as the cache ages. In the Desktop app the fuse is a hairline with a notch every 10 minutes (1h) or every minute (5m). In the terminal it is a run of line characters.
- **The lifetime in play**, `5m` or `1h`.
- **A note when something needs you**: `about to lapse` in the last five minutes (1h) or last minute (5m), `next message rewrites 212k tokens` once the cache is cold, and `last request rewrote 203k tokens` after a request that missed the cache.
- **Meters**: context with the tokens in use and the share of the window, then each rate limit window the account reports (`5h`, `wk`, and any other) with the share used and the time until it resets.

Nothing is colored while all is well. The time and fuse take the warning color when the cache is about to lapse and the error color when it is cold. A meter takes the warning color at 70% and the error color at 90%.

It also shows a toast shortly before the cache lapses and when it does, for conversations of 20k tokens or more. `/cache-countdown` prints the figures as text, for surfaces that draw no band (VS Code, `claude -p`).

If another mod draws above the prompt too, its row stays, under this one.

## Hold the cache until you're back

On the 1-hour cache, five minutes before it goes cold, a second row asks when you'll be back:

```text
4:52 ━━━─────────────────────── 1h  about to lapse   ctx 212k 21%  │  5h 28% 3h41m
back in  1h  3h  8h  12h  9:00 tomorrow  other…  │  Compact now  Let it go cold
```

- **A time** keeps the cache warm until then. About five minutes before each hour runs out, the mod sends one short request over the conversation, which reads the cache and starts its hour again. The row then shows `warm until 07:30` with a green bar for the time left, and **Change** and **Stop**.
- **Other…** turns the row into a field. Type `12h`, `90m`, `1h30m`, `07:30` or `7pm` and press Enter.
- **Compact now** runs `/compact`. **Let it go cold** hides the row until the next request.

`/hold 12h`, `/hold 07:30` or `/hold 7pm` starts a hold at any time, before you walk away. `/hold` alone says how long it has left, and `/hold off` stops it.

A hold ends when you send a message, when its time comes, or when the cache goes cold anyway. A message from a background task or a peer session doesn't end it. It lasts 24 hours at most.

Each ping costs one cache read of the whole context. At 212k tokens on Opus 5.5, that's about $0.04 a ping, so a 12-hour hold costs about $0.50, against about $1.70 to write the cache again when you come back cold. Holding costs more than going cold only after about a day and a half.

When the 5-hour limit is full, pings fail. The hold then says `can't keep warm until 16:40: 5-hour limit full`, shows a toast once, and tries again every minute. If the cache goes cold first, the hold ends and a toast says why.

## Buttons

- **Keep warm** appears on the 5-minute cache while it is about to lapse. On the 1-hour cache the hold row takes its place. It asks the model one short question over the conversation as it was last sent, which reads the cache and restarts its lifetime. That request is real usage: the whole context at the cache-read price. A toast says how many tokens were read. If the request wrote the context again instead of reading it, the toast says so and the countdown stays as it was.
- **Compact** appears beside the context meter once the conversation holds more than 200k tokens, and whenever the cache is cold and the conversation holds 20k tokens or more. It runs `/compact`, as if you had typed it, with no confirmation step. Pressed while a turn is running, it waits for the turn to end. Compacting a cold conversation still reads the whole context once, as any next message would; what it saves is carrying that context into every message after.

## Options

Set them with `/plugin configure cache-countdown@cache-countdown`, or in the `/config` panel.

| Option | Values | Default | What it does |
| :- | :- | :- | :- |
| `ttl` | `auto`, `5m`, `1h` | `auto` | Which lifetime to count down. `auto` reads it from the transcript. |
| `toast` | `true`, `false` | `true` | Toasts before and at expiry. |

## How it works

- The countdown starts from the moment the last main-conversation request was sent. Subagent requests have a cache of their own and do not reset it.
- The lifetime is read from the session transcript, where each response records how many tokens it wrote under `ephemeral_5m_input_tokens` and `ephemeral_1h_input_tokens`. Until that is known, the fuse counts the 5 minute lifetime first and the 1 hour lifetime after it, and says so.
- The transcript's tail is read with `tail`. Where `tail` is missing, as on Windows, the whole file is read, which works up to 4 MiB. Past that, the lifetime stays unconfirmed unless `ttl` is set.
- A model switch clears the countdown, since the cache is per model.
- Context and rate limit figures are the ones Claude Code reports after each turn.
- On `/resume` and `/branch` the countdown starts from the resumed conversation's last response.

## Limits

- The countdown is an estimate. Claude Code does not tell a mod when an entry lapses, and anything that shortens a lifetime on Anthropic's side is not seen.
- Keep warm and holds depend on their request reading the main conversation's cache entry. In tests on v2.1.326 a ping read the whole conversation and started its hour again. If a hold's ping writes the context instead, the hold stops and a toast says so.
- Claude Code's own idle compaction runs only on the 1-hour cache, for conversations of 200k tokens or more, when you're not near your usage limit. In terminal tests on v2.1.326 it didn't run at all. A hold doesn't wait for it.
- The mods API is early access and changes between Claude Code releases. This mod is tested with v2.1.327.

## Develop

Load the folder with `--plugin-dir`, or name it in `CLAUDE_CODE_PLUGIN_DIRS` under `env` in `~/.claude/settings.json` for sessions the Desktop app starts. Claude Code reloads the mod when a file changes.

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

## License

MIT. See [LICENSE](LICENSE).
