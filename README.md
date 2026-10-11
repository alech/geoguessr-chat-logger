# GeoGuessr Duel Chat Logger

A [Tampermonkey](https://www.tampermonkey.net/) userscript for
[GeoGuessr](https://www.geoguessr.com/).

*For duel players who want to remember the "gg"s — and see them again when
watching the replay.*

GeoGuessr duels have a chat, but it is gone once the game is over, and the
replay on the game summary page shows everything except what was said. This
userscript records the in-game chat of your duels, together with the rounds and
guesses, and plays it back alongside the replay.

## What it does

- **Records chat** — every text message, emote and reaction in duels you play,
  from both players, with the server's timestamp. Messages sent before the game,
  between rounds and after the game are kept too.
- **Records the game timeline** — when each round started, when the 15-second
  countdown began, every guess (distance and points), the health of both teams
  after each round and the winner. This is what lets chat be lined up with the
  replay.
- **Shows chat in replays** — on a duel's summary page, the **Replay** view gets
  a chat panel styled like the in-game one. Messages appear as playback reaches
  them, emotes are shown as images, and messages sent after a round ended show up
  at the end of that round's replay. Switching rounds starts with a clean panel.
- **Marks chat on the scrubber** — a dot on the replay's progress bar for every
  message in that round (gold for your opponent, purple for you). Hover a dot to
  see the message. Messages at the same spot are merged into one numbered dot.
- **Exports** — the recorded timeline can be downloaded as JSON or CSV from the
  browser console (see below), with each event's round and seconds since the
  start of the round and of the game.

The overlay only appears for games that were recorded, i.e. played in a browser
with the script installed.

## How it works

The script listens to the WebSocket connections the GeoGuessr page already
has open and never sends anything on them. The only requests it makes itself are
to `/api/v3/users/<id>`, with your existing GeoGuessr session, to look up the
nicknames of the people in the chat.

- Chat arrives over the site-wide socket (`wss://api.geoguessr.com/ws`) as
  `ChatMessage` frames on a `chat:InGame:…:<gameId>` topic. Your own messages
  are echoed back by the server, so listening is enough to capture both sides.
- Round and guess events come from the duel's game-server socket
  (`wss://gsN.geoguessr.com/…/ws`). The script compares each game state with the
  previous one rather than relying on message types, because the opponent's
  guess is only revealed once the round ends.

Everything is kept in your browser's local storage under the key `ggChatLog`,
and only there.

For the replay, the script reads the replay data the page fetches
(`/api/v4/replays/<player>/<game>/<round>`) to learn when that replay starts,
and the replay slider's position to know where playback is. GeoGuessr replays
advance in steps of 128 ms from the first recorded sample, which is how the
script converts the slider position into a point in time.

## Installation

1. Install the [Tampermonkey](https://www.tampermonkey.net/) browser extension.
2. Open the
   [userscript](https://github.com/alech/geoguessr-chat-logger/raw/refs/heads/main/geoguessr-chat-logger.user.js)
   — Tampermonkey detects the `.user.js` file and prompts you to install it.
3. Play a duel. Afterwards, open the game's summary page and switch to
   **Replay**.

The script has to be active when the page loads (it runs at `document-start`),
so reload any GeoGuessr tabs that were open while you installed it.

## Exporting and managing the log

Open the browser's developer console on any GeoGuessr page:

| Command | |
|---|---|
| `ggChat.games()` | game IDs with recorded events |
| `ggChat.timeline(gameId)` | sorted events of one game (all games without an ID) |
| `ggChat.downloadCsv(gameId)` | download as `geoguessr-chats-<gameId>.csv` (all games without an ID) |
| `ggChat.downloadJson(gameId)` | the same as JSON |
| `ggChat.log()` | the raw stored log |
| `ggChat.clear()` | delete everything the script has stored |

## Privacy — use at your own risk, and be kind

This script keeps a record of conversations with other people. Please think
about what that means before you use it:

- **What's said in chat may be personal.** People occasionally share things in
  chat they would not want kept — names, where they live, other contact details,
  or just a bad moment. Everything is recorded as-is, including the other
  player's user ID and nickname.
- **It stays on your machine unless you move it.** The script stores the log in
  your browser only and sends it nowhere. Exports, screenshots and shared files
  are a different matter: don't publish someone else's messages without their
  consent, and consider removing identifying details before sharing anything.
- **Delete what you don't need.** `ggChat.clear()` removes the whole log;
  clearing GeoGuessr's site data in your browser does the same.
- **It is your responsibility.** Whether recording chat is appropriate — legally,
  under GeoGuessr's terms, or simply socially — depends on where you are and
  whom you are talking to. The script comes without any warranty, and you use
  it at your own risk.

In short: record the good games and the friendly "gg"s, and treat other
people's words the way you'd want yours treated.

## Caveats

The replay overlay finds its way around the summary page through GeoGuessr's
generated CSS class names (`duel-breakdown_playbackSlider…`,
`duel-breakdown_replayFooter…`) and the emote images through their hashed file
names. If GeoGuessr changes its replay page, the overlay may not appear, or
emotes may show as text such as `:gg:`, until the script is updated. Recording
only depends on the WebSocket messages and keeps working through such changes.

The script has only been tried with regular one-on-one duels. Team duels,
including team-only chat, should be recorded too, but that is untested.

## License

Released under [CC0 1.0 Universal](LICENSE) — public domain.
