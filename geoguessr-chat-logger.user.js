// ==UserScript==
// @name         GeoGuessr Duel Chat Logger
// @namespace    https://github.com/alech/geoguessr-chat-logger
// @version      1.0.0
// @description  Records duel chat and round events locally and shows the chat in duel replays.
// @author       Alexander Klink
// @homepageURL  https://github.com/alech/geoguessr-chat-logger
// @downloadURL  https://github.com/alech/geoguessr-chat-logger/raw/refs/heads/main/geoguessr-chat-logger.user.js
// @updateURL    https://github.com/alech/geoguessr-chat-logger/raw/refs/heads/main/geoguessr-chat-logger.user.js
// @match        https://www.geoguessr.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const STORAGE_KEY = "ggChatLog";
  const CHAT_TOPIC = /^chat:(InGame|PostGame):[^:]+:([^:]+)(?::(.+))?$/;
  const nickCache = new Map();

  const load = () => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    } catch {
      return [];
    }
  };
  const save = (log) => localStorage.setItem(STORAGE_KEY, JSON.stringify(log));

  function nick(userId) {
    if (!userId) return Promise.resolve(null);
    if (!nickCache.has(userId)) {
      nickCache.set(
        userId,
        fetch(`/api/v3/users/${userId}`, { credentials: "include" })
          .then((r) => (r.ok ? r.json() : null))
          .then((u) => u?.nick ?? null)
          .catch(() => null),
      );
    }
    return nickCache.get(userId);
  }

  // Appends entries whose `key` is not yet in the log; returns the ones added.
  function append(entries) {
    const log = load();
    const seen = new Set(log.map((e) => e.key));
    const fresh = entries.filter((e) => !seen.has(e.key));
    if (!fresh.length) return;
    save([...log, ...fresh]);
    for (const e of fresh) {
      const who = e.nick ?? e.userId ?? "";
      const extra = e.reactsTo ? ` → ${e.reactsTo}` : "";
      console.log(`[ggChat] ${e.ts} r${e.round ?? "?"} ${e.type} ${who}: ${e.text ?? ""}${extra}`);
    }
  }

  // ---- chat (api.geoguessr.com/ws) ----

  async function onChatFrame(frame) {
    const m = CHAT_TOPIC.exec(frame.topic ?? "");
    if (!m) return;
    const payload = JSON.parse(frame.payload);
    const reaction = payload.reactionPayload ?? null;
    const target = reaction && load().find((e) => e.raw?.id === reaction.targetMessageId);
    append([
      {
        key: `chat:${payload.id ?? crypto.randomUUID()}`,
        kind: "chat",
        ts: frame.timestamp ?? payload.sentAt ?? new Date().toISOString(),
        receivedAt: new Date().toISOString(),
        gameId: m[2],
        channel: m[3] ?? "all",
        userId: payload.sourceId ?? null,
        nick: await nick(payload.sourceId),
        type: payload.payloadType,
        text: payload.textPayload ?? reaction?.emote ?? null,
        reactsTo: target ? `${target.nick ?? target.userId}: ${target.text}` : null,
        raw: payload,
      },
    ]);
  }

  // ---- game events (gsN.geoguessr.com/.../ws) ----

  const gameEvent = (state, type, ts, fields = {}) => ({
    key: `game:${state.gameId}:${type}:${fields.round ?? ""}:${fields.userId ?? ""}`,
    kind: "game",
    ts,
    gameId: state.gameId,
    type,
    ...fields,
  });

  function roundEvents(state) {
    return state.rounds.flatMap((r) => {
      const round = r.roundNumber;
      const out = [];
      if (r.startTime) out.push(gameEvent(state, "RoundStart", r.startTime, { round }));
      if (r.timerStartTime) out.push(gameEvent(state, "TimerStart", r.timerStartTime, { round }));
      return out;
    });
  }

  async function guessEvents(state) {
    const players = state.teams.flatMap((t) => t.players.map((p) => ({ team: t.name, ...p })));
    const out = [];
    for (const p of players) {
      // The opponent's guess is redacted (score null) until the round ends.
      for (const g of p.guesses.filter((x) => x.score !== null)) {
        out.push(
          gameEvent(state, "Guess", g.created, {
            round: g.roundNumber,
            userId: p.playerId,
            nick: await nick(p.playerId),
            text: `${p.team}: ${(g.distance / 1000).toFixed(1)} km, ${g.score} pts`,
            raw: g,
          }),
        );
      }
    }
    return out;
  }

  function roundEndEvent(state, ts) {
    const round = state.currentRoundNumber;
    const health = state.teams
      .map((t) => {
        const rr = t.roundResults.find((x) => x.roundNumber === round);
        return `${t.name} ${rr?.healthAfter ?? t.health}`;
      })
      .join(", ");
    return gameEvent(state, "RoundEnd", ts, { round, text: `health: ${health}` });
  }

  async function onGameFrame(frame) {
    const state = frame.duel?.state;
    if (!state?.rounds || !frame.timestamp) return;
    const events = [...roundEvents(state), ...(await guessEvents(state))];
    if (frame.code === "DuelRoundTimedOut") events.push(roundEndEvent(state, frame.timestamp));
    if (frame.code === "DuelFinished") {
      const r = state.result;
      const winner = state.teams.find((t) => t.id === r?.winningTeamId)?.name;
      const text = r?.isDraw ? "draw" : `winner: ${winner} (${r?.winnerStyle})`;
      events.push(gameEvent(state, "GameEnd", frame.timestamp, { text }));
    }
    append(events);
  }

  // ---- socket hook ----

  function handlerFor(url) {
    const u = new URL(url);
    if (!u.hostname.endsWith("geoguessr.com") || !u.pathname.endsWith("/ws")) return null;
    if (u.hostname === "api.geoguessr.com") return { marker: '"ChatMessage"', fn: onChatFrame };
    return { marker: '"Duel', fn: onGameFrame };
  }

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url, protocols) {
      super(url, protocols);
      const handler = handlerFor(String(url));
      if (!handler) return;
      this.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string" || !ev.data.includes(handler.marker)) return;
        try {
          handler.fn(JSON.parse(ev.data)).catch((err) => console.warn("[ggChat]", err));
        } catch (err) {
          console.warn("[ggChat] failed to parse frame", err);
        }
      });
    }
  };

  // ---- export ----

  // Sorted timeline with round number and seconds since round / game start for replay alignment.
  function timeline(gameId) {
    const log = load().filter((e) => !gameId || e.gameId === gameId);
    log.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    const starts = log.filter((e) => e.type === "RoundStart");
    return log.map((e) => {
      const t = Date.parse(e.ts);
      const own = starts.filter((s) => s.gameId === e.gameId);
      const current = own.filter((s) => Date.parse(s.ts) <= t).at(-1);
      const sec = (from) => (from ? ((t - Date.parse(from.ts)) / 1000).toFixed(1) : null);
      const round = e.round ?? current?.round ?? 0;
      return { ...e, round, sinceRound: sec(current), sinceGame: sec(own[0]) };
    });
  }

  function download(name, body, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const csvCell = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const COLS = ["ts", "round", "sinceRound", "sinceGame", "kind", "type", "channel", "nick",
    "userId", "text", "reactsTo", "gameId"];

  const exportName = (gameId, ext) => `geoguessr-chats${gameId ? `-${gameId}` : ""}.${ext}`;

  window.ggChat = {
    log: load,
    timeline,
    games: () => [...new Set(load().map((e) => e.gameId))],
    clear: () => save([]),
    downloadJson: (gameId) =>
      download(exportName(gameId, "json"), JSON.stringify(timeline(gameId), null, 2),
        "application/json"),
    downloadCsv: (gameId) => {
      const rows = timeline(gameId).map((e) => COLS.map((c) => csvCell(e[c])).join(","));
      download(exportName(gameId, "csv"), [COLS.join(","), ...rows].join("\n"), "text/csv");
    },
  };

  // ---- replay overlay (/duels/<gameId>/summary) ----

  // Replay playback advances in fixed 128 ms steps from the first sample (GeoGuessr's `ld`).
  const STEP_S = 0.128;
  const REPLAY_URL = /\/api\/v4\/replays\/([^/]+)\/([^/]+)\/(\d+)/;
  const SUMMARY_URL = /^\/duels\/([^/]+)\/summary/;
  const EMOTE_IMG = {
    ":beenthere:": "emote-beenthere.42365351", ":confused:": "emote-confused.df3551a4",
    ":cool:": "emote-cool.99cc756d", ":cry:": "emote-cry.f50ab7fc", ":gg:": "emote-gg.734e9267",
    ":goat:": "emote-goat.d609af13", ":goodguess:": "emote-goodguess.bc4b08ea",
    ":happy:": "emote-happy.22ddb307", ":luckyguess:": "emote-luckyguess.9c230a84",
    ":mindblown:": "emote-mindblown.b90f46cb", ":thankyou:": "emote-thankyou.3463c7d8",
    ":wave:": "emote-wave.3b6cd321",
  };
  // Every replay the page has fetched: { playerId, gameId, round, t0, numSteps, fetchedAt }.
  const replays = [];

  function rememberReplay(url, samples) {
    const m = REPLAY_URL.exec(url);
    if (!m || !Array.isArray(samples) || !samples.length) return;
    const t0 = samples[0].time;
    // Same arithmetic as GeoGuessr: one extra second after the last sample, then ceil.
    const numSteps = Math.ceil((samples.at(-1).time + 1000 - t0) / 1e3 / STEP_S);
    replays.push({ playerId: m[1], gameId: m[2], round: Number(m[3]), t0, numSteps,
      fetchedAt: Date.now() });
  }

  const nativeFetch = window.fetch;
  window.fetch = async (input, init) => {
    const res = await nativeFetch(input, init);
    const url = typeof input === "string" ? input : input?.url ?? "";
    if (REPLAY_URL.test(url)) {
      res.clone().json().then((s) => rememberReplay(url, s)).catch(() => {});
    }
    return res;
  };

  // The page writes player/round into the URL while paused (round omitted = 1). Otherwise
  // pick the replay whose step count matches the slider; newest fetch wins ties.
  function currentReplay(gameId, maxStep) {
    const own = replays.filter((r) => r.gameId === gameId);
    const q = new URLSearchParams(location.search);
    const round = Number(q.get("round") ?? 1);
    const byUrl = own.filter((r) => r.playerId === q.get("player") && r.round === round);
    const bySteps = own.filter((r) => r.numSteps === maxStep + 1);
    const pool = [byUrl.filter((r) => r.numSteps === maxStep + 1), bySteps, own]
      .find((p) => p.length);
    return pool?.sort((a, b) => b.fetchedAt - a.fetchedAt)[0];
  }

  // Wall-clock window covered by a round's replay: until the next round starts (or forever).
  // Round 1 also owns everything said before the game started.
  function roundWindow(log, replay) {
    const next = log.find((e) => e.type === "RoundStart" && e.round === replay.round + 1);
    return {
      t0: replay.t0,
      from: replay.round === 1 ? -Infinity : replay.t0,
      end: next ? Date.parse(next.ts) : Infinity,
    };
  }

  // z-index 25: above the replay guess map (22), which grows to cover the corner at round end.
  const OVERLAY_CSS = `
    .ggc-panel{position:absolute;left:1rem;bottom:9rem;z-index:25;width:min(22rem,40%);
      max-height:40%;overflow-y:auto;display:flex;flex-direction:column;gap:.125rem;
      padding:.5rem 0;border-radius:.75rem;background:rgba(16,16,40,.55);
      backdrop-filter:blur(4px);scrollbar-width:thin}
    .ggc-panel:empty{display:none}
    .ggc-row{display:flex;flex-direction:column;align-items:flex-start;padding-inline:.75rem}
    .ggc-row.ggc-new{animation:ggc-in .2s ease-out}
    .ggc-row.ggc-self{align-items:flex-end}
    .ggc-nick{font-weight:700;font-size:.75rem;padding:0 .25rem;
      color:var(--ds-color-purple-20,#c9b8ff)}
    .ggc-meta{font-weight:400;font-size:.625rem;margin-left:.375rem;
      color:var(--ds-color-white-40,rgba(255,255,255,.4))}
    .ggc-bubble{padding:.5rem .75rem;border-radius:.75rem;font-size:.75rem;line-height:1.35;
      max-width:85%;overflow-wrap:anywhere;white-space:pre-wrap;color:rgba(255,255,255,.85);
      background:var(--ds-color-white-5,rgba(255,255,255,.08))}
    .ggc-self .ggc-bubble{color:#fff;
      background:color-mix(in srgb,var(--ds-color-purple-70,#6c3cf0) 40%,transparent)}
    .ggc-emote{background:none!important;padding:0}
    .ggc-emote img{width:3rem;height:3rem;display:block}
    .ggc-markers{position:absolute;inset:0;pointer-events:none;z-index:3}
    .ggc-marker{position:absolute;top:50%;width:.625rem;height:.625rem;
      margin:-.3125rem 0 0 -.3125rem;border-radius:50%;background:#fecd19;
      box-shadow:0 0 0 2px rgba(0,0,0,.6);pointer-events:auto;cursor:pointer}
    .ggc-marker.ggc-self{background:#a78bfa}
    .ggc-marker.ggc-multi{width:.875rem;height:.875rem;margin:-.4375rem 0 0 -.4375rem;
      font:700 .5rem/.875rem sans-serif;text-align:center;color:#000}
    .ggc-tip{display:none;position:absolute;bottom:160%;left:50%;transform:translateX(-50%);
      white-space:nowrap;padding:.375rem .5rem;border-radius:.5rem;
      background:rgba(16,16,40,.95);color:#fff;font:400 .75rem/1.4 sans-serif;
      text-align:left;pointer-events:none}
    .ggc-marker:hover .ggc-tip{display:block}
    .ggc-tip-line{display:flex;align-items:center;gap:.25rem;min-height:1.5rem}
    .ggc-tip-line b{color:var(--ds-color-purple-20,#c9b8ff)}
    .ggc-tip img{width:1.5rem;height:1.5rem}
    @keyframes ggc-in{from{opacity:0;transform:translateY(.25rem)}}`;

  // Image for an emote code like ":wave:" (whitespace tolerated, as in the game); null if none.
  function emoteNode(code) {
    const name = EMOTE_IMG[(code ?? "").trim()];
    if (!name) return null;
    const direct = `/_next/static/media/${name}.webp`;
    const img = document.createElement("img");
    img.src = direct;
    img.alt = img.title = code.trim();
    img.addEventListener("error", () => {
      if (img.src.includes("/_next/image")) {
        console.warn("[ggChat] emote image failed", direct);
        img.replaceWith(img.alt);
        return;
      }
      img.src = `/_next/image?url=${encodeURIComponent(direct)}&w=128&q=75`;
    });
    return img;
  }

  function messageNode(msg, selfId) {
    const row = document.createElement("div");
    row.className = `ggc-row ggc-new${msg.userId === selfId ? " ggc-self" : ""}`;
    row.addEventListener("animationend", () => row.classList.remove("ggc-new"));
    const nick = document.createElement("div");
    nick.className = "ggc-nick";
    nick.textContent = msg.nick ?? msg.userId ?? "?";
    const meta = document.createElement("span");
    meta.className = "ggc-meta";
    nick.append(meta);
    const bubble = document.createElement("div");
    bubble.className = "ggc-bubble";
    // Like the game: a message consisting only of an emote code renders as the emote.
    const emote = emoteNode(msg.text);
    if (emote) bubble.classList.add("ggc-emote");
    bubble.append(emote ?? `${msg.text ?? ""}${msg.reactsTo ? ` ↩ ${msg.reactsTo}` : ""}`);
    row.append(nick, bubble);
    return row;
  }

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const overlay = {
    panel: null, markers: null, nodes: new Map(), panelKey: "", markerKey: "", last: null,
  };

  function ensureStyle() {
    if (document.getElementById("ggc-style")) return;
    const style = document.createElement("style");
    style.id = "ggc-style";
    style.textContent = OVERLAY_CSS;
    document.head.append(style);
  }

  // The replay controls live in a footer that slides out of view at the end of a round, so the
  // panel goes into the footer's parent (the replay stage) instead of inside the footer.
  function ensurePanel(slider, footer) {
    if (overlay.panel?.isConnected) return;
    let stage = footer?.parentElement;
    if (!stage || getComputedStyle(footer).position !== "absolute") {
      stage = slider;
      while (stage.parentElement && stage.offsetHeight < 300) stage = stage.parentElement;
    }
    if (getComputedStyle(stage).position === "static") stage.style.position = "relative";
    overlay.panel = document.createElement("div");
    overlay.panel.className = "ggc-panel";
    stage.append(overlay.panel);
    overlay.panelKey = "";
  }

  // Sits just above the footer; drops to the bottom while the footer is slid away.
  function placePanel(footer) {
    const hidden = !footer || /Exiting/.test(footer.className);
    const bottom = hidden ? "1rem" : `${footer.offsetHeight + 8}px`;
    if (overlay.panel.style.bottom !== bottom) overlay.panel.style.bottom = bottom;
  }

  function ensureMarkers(slider) {
    if (overlay.markers?.isConnected && overlay.markers.parentElement === slider) return;
    overlay.markers?.remove();
    overlay.markers = document.createElement("div");
    overlay.markers.className = "ggc-markers";
    slider.append(overlay.markers);
    overlay.markerKey = "";
  }

  function removeOverlay() {
    overlay.panel?.remove();
    overlay.markers?.remove();
    overlay.panel = overlay.markers = null;
    overlay.nodes.clear();
    overlay.panelKey = overlay.markerKey = "";
    overlay.last = null;
  }

  function tooltipNode(items) {
    const tip = document.createElement("div");
    tip.className = "ggc-tip";
    for (const c of items) {
      const line = document.createElement("div");
      line.className = "ggc-tip-line";
      const nick = document.createElement("b");
      nick.textContent = `${c.nick ?? "?"}:`;
      line.append(nick, emoteNode(c.text) ?? c.text ?? "");
      tip.append(line);
    }
    return tip;
  }

  // Groups messages that land within a few pixels of each other into one marker.
  function markerGroups(chats, xOf) {
    const groups = [];
    for (const c of chats) {
      const x = xOf(c);
      const last = groups.at(-1);
      if (last && x - last.x < 8) last.items.push(c);
      else groups.push({ x, items: [c] });
    }
    return groups;
  }

  function renderMarkers(slider, chats, stepOf, maxStep, selfId) {
    const handle = slider.querySelector('[class*="styles_handle"]');
    const grab = (handle?.offsetWidth ?? 0) / 2;
    const span = slider.offsetWidth - 2 * grab;
    const key = [chats.map((c) => c.key).join(), maxStep, span].join("|");
    if (key === overlay.markerKey) return;
    overlay.markerKey = key;
    const xOf = (c) => grab + (span * stepOf(c)) / Math.max(1, maxStep);
    overlay.markers.replaceChildren(
      ...markerGroups(chats, xOf).map(({ x, items }) => {
        const dot = document.createElement("div");
        const mine = items.every((c) => c.userId === selfId);
        dot.className = "ggc-marker";
        dot.classList.toggle("ggc-self", mine);
        dot.classList.toggle("ggc-multi", items.length > 1);
        dot.style.left = `${x}px`;
        if (items.length > 1) dot.textContent = String(items.length);
        dot.append(tooltipNode(items));
        return dot;
      }),
    );
  }

  // Shows the current round's chat up to `playhead`; only touches the DOM when that changes.
  function renderPanel(chats, playhead, win, selfId) {
    const visible = chats.filter((c) => Date.parse(c.ts) <= playhead);
    const key = `${win.t0}|${visible.map((c) => c.key).join()}`;
    if (key === overlay.panelKey) return;
    const atBottom = overlay.panel.scrollHeight - overlay.panel.scrollTop
      - overlay.panel.clientHeight < 40;
    overlay.panelKey = key;
    overlay.panel.replaceChildren(
      ...visible.map((c) => {
        let node = overlay.nodes.get(c.key);
        if (!node) overlay.nodes.set(c.key, (node = messageNode(c, selfId)));
        node.querySelector(".ggc-meta").textContent = fmtClock(Date.parse(c.ts) - win.t0);
        return node;
      }),
    );
    if (atBottom) overlay.panel.scrollTop = 1e9;
  }

  function tick() {
    const gameId = SUMMARY_URL.exec(location.pathname)?.[1];
    if (!gameId) return removeOverlay();
    const slider = document.querySelector(
      '[class*="duel-breakdown_playbackSlider"] [aria-valuenow]',
    );
    // Controls gone (re-mount, or round result shown): keep the panel, and if playback was
    // within a second of the end, show the whole round including the post-round chat.
    if (!slider) {
      const last = overlay.last;
      if (overlay.panel?.isConnected && last && last.step >= last.maxStep - 8) {
        renderPanel(last.roundChats, last.win.end - 1, last.win, last.selfId);
      }
      return;
    }
    const step = Number(slider.getAttribute("aria-valuenow"));
    const maxStep = Number(slider.getAttribute("aria-valuemax"));
    const replay = currentReplay(gameId, maxStep);
    if (!replay) return;
    const log = timeline(gameId);
    const chats = log.filter((e) => e.kind === "chat");
    const win = roundWindow(log, replay);
    // At the last step, include everything said before the next round started.
    const playhead = step >= maxStep ? win.end - 1 : replay.t0 + step * STEP_S * 1e3;
    const stepOf = (c) => Math.min(maxStep,
      Math.max(0, Math.round((Date.parse(c.ts) - replay.t0) / 1e3 / STEP_S)));
    const selfId = currentUserId();
    ensureStyle();
    const footer = slider.closest('[class*="duel-breakdown_replayFooter"]');
    ensurePanel(slider, footer);
    placePanel(footer);
    ensureMarkers(slider);
    const roundChats = chats.filter((c) => Date.parse(c.ts) >= win.from
      && Date.parse(c.ts) < win.end);
    renderMarkers(slider, roundChats, stepOf, maxStep, selfId);
    renderPanel(roundChats, playhead, win, selfId);
    overlay.last = { step, maxStep, roundChats, win, selfId };
  }

  // The logged-in user's id from Next.js page data.
  const currentUserId = () => window.__NEXT_DATA__?.props?.accountProps?.account?.user?.userId;

  setInterval(tick, 100);
})();
