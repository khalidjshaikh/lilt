import { AudioEngine } from "./audio.js";
import {
  CALL_TO_DATA_MS,
  MAX_PAYLOAD_BYTES,
  SYMBOL_SECONDS,
  TONE_FREQS,
  bodyBlockCount,
  buildPacket,
} from "./protocol.js";
import {
  Demodulator,
  detectCall,
  findSyncCandidates,
  frameDurationSeconds,
  locateFrame,
  readBodyAt,
  readHeaderAt,
  synthesizePacket,
} from "./dsp.js";

const $ = (id) => document.getElementById(id);

const ui = {
  input: $("messageInput"),
  byteCount: $("byteCount"),
  airtime: $("airtime"),
  hint: $("composeHint"),
  sendButton: $("sendButton"),
  sendLabel: $("sendButton").querySelector("span:last-child"),
  transmitProgress: $("transmitProgress"),
  micButton: $("micButton"),
  listenText: $("listenText"),
  levelBar: $("levelBar"),
  messages: $("messages"),
  messageList: $("messageList"),
  emptyState: $("emptyState"),
  receiveMeta: $("receiveMeta"),
  clearButton: $("clearButton"),
  signalStatus: $("signalStatus"),
  statusText: $("statusText"),
  scopeTitle: $("scopeTitle"),
  scopeCanvas: $("scopeCanvas"),
  scopeIdle: $("scopeIdle"),
  volumeInput: $("volumeInput"),
  aboutButton: $("aboutButton"),
  aboutDialog: $("aboutDialog"),
  closeAbout: $("closeAbout"),
  sampleButton: $("sampleButton"),
  toneTable: $("toneTable"),
  toast: $("toast"),
};

const encoder = new TextEncoder();
const state = {
  messages: [],
  seen: new Map(),
  pending: null,
  lastCallAt: -Infinity,
  receivedCount: 0,
  toastTimer: 0,
  txRaf: 0,
  txStartedAt: 0,
  lastStatusPaint: 0,
  barLevels: new Float32Array(TONE_FREQS.length),
};

const engine = new AudioEngine({
  volume: Number(ui.volumeInput.value) / 100,
  onStateChange: handleEngineState,
});

/* ------------------------------------------------------------------ */
/* Small interface helpers                                             */
/* ------------------------------------------------------------------ */

function showToast(text, duration = 3200) {
  window.clearTimeout(state.toastTimer);
  ui.toast.textContent = text;
  ui.toast.classList.add("show");
  state.toastTimer = window.setTimeout(() => {
    ui.toast.classList.remove("show");
  }, duration);
}

function setStatus(text, mode) {
  ui.statusText.textContent = text;
  ui.signalStatus.dataset.state = mode;
}

function setListenMessage(text, className = "") {
  ui.listenText.textContent = text;
  ui.listenText.className = className;
}

function updateCompose() {
  const value = ui.input.value;
  const bytes = encoder.encode(value).length;
  const over = bytes > MAX_PAYLOAD_BYTES;
  ui.byteCount.textContent = `${bytes} / ${MAX_PAYLOAD_BYTES} bytes`;
  ui.byteCount.classList.toggle("over", over);

  if (bytes === 0) {
    ui.airtime.textContent = "≈ 0 s of air";
  } else {
    const blocks = bodyBlockCount(bytes);
    const seconds =
      (CALL_TO_DATA_MS / 1000) +
      (8 + 15 + blocks * 15) * SYMBOL_SECONDS;
    ui.airtime.textContent = `≈ ${seconds.toFixed(1)} s of air`;
  }

  if (over) {
    ui.hint.textContent = "That is over the 512-byte limit. Air is a small room.";
  } else {
    ui.hint.textContent =
      "Keep it short. Lilt is a language for small, deliberate messages.";
  }

  ui.sendButton.disabled =
    value.trim().length === 0 || over || engine.transmitting;
  if (!engine.transmitting) ui.sendLabel.textContent = "Send by sound";
}

function updateMicButton() {
  ui.micButton.textContent = engine.listening
    ? "Close microphone"
    : "Open microphone";
}

function updateReceiveMeta() {
  const count = state.messages.length;
  ui.receiveMeta.textContent = `${count} message${count === 1 ? "" : "s"} heard`;
  ui.clearButton.disabled = count === 0;
}

function updateScopeIdle() {
  if (engine.transmitting) {
    ui.scopeIdle.textContent = "singing";
    ui.scopeIdle.classList.add("hidden");
    return;
  }
  if (engine.listening) {
    ui.scopeIdle.textContent = "microphone live";
    ui.scopeIdle.classList.remove("hidden");
  } else {
    ui.scopeIdle.textContent = "waiting for sound";
    ui.scopeIdle.classList.remove("hidden");
  }
}

function handleEngineState() {
  updateMicButton();
  updateScopeIdle();

  if (engine.transmitting) {
    ui.sendLabel.textContent = "Singing…";
    ui.sendButton.disabled = true;
    ui.input.readOnly = true;
    ui.scopeTitle.textContent = "Singing";
    setStatus("Singing into the room", "singing");
    return;
  }

  ui.input.readOnly = false;
  updateCompose();
  if (state.pending) return;

  ui.scopeTitle.textContent = engine.listening ? "Listening" : "Room tone";
  if (engine.listening) {
    setStatus("Listening · mic open", "listening");
    setListenMessage(
      "Listening for the two-tone call. Keep this window open.",
      "is-listening",
    );
  } else {
    setStatus("Microphone off", "off");
    setListenMessage(
      "The microphone is closed. Open it to let this computer listen for a call.",
      "",
    );
  }
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

function formatTime(date) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function makeQuality(confidence) {
  const wrap = document.createElement("span");
  wrap.className = "message-quality";
  wrap.title = "Signal quality";
  wrap.setAttribute("aria-label", "Signal quality");
  const active = Math.max(1, Math.min(5, Math.round((confidence || 0) * 5)));
  for (let i = 0; i < 5; i += 1) {
    const bar = document.createElement("i");
    if (i < active) bar.classList.add("on");
    wrap.append(bar);
  }
  return wrap;
}

function makeMessageNode(message) {
  const article = document.createElement("article");
  article.className = "message";

  const meta = document.createElement("div");
  meta.className = "message-meta";

  const number = document.createElement("span");
  number.className = "message-number";
  number.textContent = `#${String(message.number).padStart(2, "0")}`;

  const time = document.createElement("span");
  time.className = "message-time";
  time.textContent = formatTime(message.time);

  meta.append(number, time, makeQuality(message.confidence));

  const text = document.createElement("p");
  text.className = "message-text";
  text.textContent = message.text;

  const foot = document.createElement("div");
  foot.className = "message-foot";

  const bytes = document.createElement("span");
  bytes.textContent = `${message.bytes} bytes · sealed`;

  const id = document.createElement("span");
  id.textContent = `id ${message.messageId.toString(16).padStart(2, "0").toUpperCase()}`;

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "message-copy";
  copy.textContent = "Copy";
  copy.addEventListener("click", () => copyText(message.text));

  foot.append(bytes, id, copy);
  article.append(meta, text, foot);
  return article;
}

function addMessage(message) {
  state.messages.unshift(message);
  if (state.messages.length > 40) state.messages.length = 40;
  ui.emptyState.hidden = true;
  ui.messageList.prepend(makeMessageNode(message));
  while (ui.messageList.children.length > 40) {
    ui.messageList.lastElementChild.remove();
  }
  updateReceiveMeta();
}

function resetMessages() {
  state.messages = [];
  state.seen.clear();
  ui.messageList.replaceChildren();
  ui.emptyState.hidden = false;
  updateReceiveMeta();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Copied the message.");
    return;
  } catch {
    // Older browsers, or a page that is not in a secure context.
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    document.execCommand("copy");
    showToast("Copied the message.");
  } catch {
    showToast("The browser would not copy that.");
  }
  area.remove();
}

function previewOf(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= 38) return clean;
  return `${clean.slice(0, 37)}…`;
}

function acceptMessage(text, header, confidence, callAbs) {
  const now = new Date();
  const key = `${header.messageId}:${text}`;
  const previous = state.seen.get(key);
  state.pending = null;
  state.lastCallAt = callAbs;

  if (previous && now.getTime() - previous < 60_000) {
    setStatus(engine.listening ? "Listening · mic open" : "Microphone off", engine.listening ? "listening" : "off");
    setListenMessage("That message had already arrived. Listening again.", "is-listening");
    ui.scopeTitle.textContent = engine.listening ? "Listening" : "Room tone";
    showToast("Heard that one again.");
    return;
  }
  for (const [oldKey, timestamp] of state.seen) {
    if (now.getTime() - timestamp > 120_000) state.seen.delete(oldKey);
  }
  state.seen.set(key, now.getTime());
  state.receivedCount += 1;

  addMessage({
    number: state.receivedCount,
    text,
    bytes: header.payloadLength,
    messageId: header.messageId,
    confidence,
    time: now,
  });

  setStatus(engine.listening ? "Listening · mic open" : "Microphone off", engine.listening ? "listening" : "off");
  setListenMessage(`Heard “${previewOf(text)}”. Listening again.`, "is-listening");
  ui.scopeTitle.textContent = engine.listening ? "Listening" : "Room tone";
  showToast("A message landed.");
}

function failPending(reason) {
  state.pending = null;
  setStatus(engine.listening ? "Listening · mic open" : "Microphone off", engine.listening ? "listening" : "off");
  setListenMessage(`${reason} Listening again.`, engine.listening ? "is-listening" : "");
  ui.scopeTitle.textContent = engine.listening ? "Listening" : "Room tone";
  showToast(reason);
}

/* ------------------------------------------------------------------ */
/* Receiving                                                           */
/* ------------------------------------------------------------------ */

function startPending(callAbs) {
  state.lastCallAt = callAbs;
  state.pending = {
    callAbs,
    nextAttemptAbs: callAbs + Math.round(2.05 * engine.sampleRate),
    attempts: 0,
    bodyAttempts: 0,
    header: null,
    syncOffset: null,
    bodyStart: null,
    segStart: null,
    demodulator: null,
    expectedEndAbs: Infinity,
    triedCandidates: false,
    lastWaitAt: 0,
  };
  setStatus("A call in the air", "hearing");
  setListenMessage("A call was heard. Finding the greeting…", "is-hearing");
  ui.scopeTitle.textContent = "Decoding";
}

function tick() {
  try {
    if (!engine.listening || engine.transmitting || !engine.ring) return;
    const sr = engine.sampleRate;
    const now = engine.ring.total;

    if (state.pending) {
      processPending(now, sr);
      return;
    }

    if (now < Math.round(1.2 * sr)) return;
    const windowSamples = Math.min(Math.round(1.8 * sr), now);
    const segmentStart = now - windowSamples;
    const segment = engine.ring.slice(segmentStart, now);
    const call = detectCall(segment, sr, { threshold: 0.0035 });
    if (!call) return;

    const callAbs = segmentStart + call.startSample;
    if (callAbs <= state.lastCallAt + Math.round(1.5 * sr)) return;
    startPending(callAbs);
  } catch (error) {
    console.error(error);
    if (state.pending) {
      failPending("The receiver lost its place in the air.");
    }
  }
}

function processPending(now, sr) {
  const pending = state.pending;
  if (!pending) return;

  if (now < pending.nextAttemptAbs) {
    if (
      pending.header &&
      now - pending.lastWaitAt > sr &&
      pending.expectedEndAbs !== Infinity
    ) {
      const remaining = Math.max(0, (pending.expectedEndAbs - now) / sr);
      if (remaining > 0.2) {
        setListenMessage(
          `Head read. ${Math.ceil(remaining)} seconds of body still in the air…`,
          "is-hearing",
        );
      } else {
        setListenMessage("Body complete. Unweaving the syllables…", "is-hearing");
      }
      pending.lastWaitAt = now;
    }
    return;
  }

  const segStart = Math.max(
    engine.ring.start,
    pending.callAbs - Math.round(0.25 * sr),
  );
  const approxSync =
    pending.callAbs +
    Math.round((CALL_TO_DATA_MS / 1000) * sr) -
    segStart;

  if (!pending.header) {
    const segEnd = Math.min(now, pending.callAbs + Math.round(4.5 * sr));
    if (segEnd - segStart < Math.round(2.1 * sr)) return;

    pending.attempts += 1;
    const segment = engine.ring.slice(segStart, segEnd);
    const located = locateFrame(segment, approxSync, sr, {
      range: 0.18,
      count: 4,
    });

    if (located.header) {
      pending.header = located.header;
      pending.syncOffset = located.syncOffset;
      pending.bodyStart = located.bodyStart;
      pending.segStart = segStart;
      pending.demodulator = located.demodulator;
      pending.expectedEndAbs =
        pending.callAbs + frameDurationSeconds(pending.header) * sr;
      pending.nextAttemptAbs = pending.expectedEndAbs + Math.round(0.18 * sr);
      pending.lastWaitAt = 0;
      setStatus("Unweaving the words", "hearing");
      setListenMessage("Head read. Waiting for the body…", "is-hearing");
      return;
    }

    if (pending.attempts >= 4 && now > pending.callAbs + Math.round(4.2 * sr)) {
      failPending("The call dissolved before I could read it.");
      return;
    }
    pending.nextAttemptAbs = now + Math.round(0.55 * sr);
    return;
  }

  if (now < pending.expectedEndAbs + Math.round(0.18 * sr)) return;
  if (now > pending.expectedEndAbs + Math.round(8 * sr)) {
    failPending("The message stopped arriving before its end.");
    return;
  }

  pending.bodyAttempts += 1;
  const fullEnd = Math.min(now, pending.expectedEndAbs + Math.round(0.8 * sr));
  const full = engine.ring.slice(pending.segStart, fullEnd);
  const frame = {
    header: pending.header,
    bodyStart: pending.bodyStart,
    demodulator: pending.demodulator,
  };
  const body = readBodyAt(full, frame, sr, pending.demodulator);

  if (body.ok) {
    acceptMessage(body.text, pending.header, body.confidence, pending.callAbs);
    return;
  }

  if (body.waiting && pending.bodyAttempts < 5) {
    pending.nextAttemptAbs = now + Math.round(0.35 * sr);
    return;
  }

  if (!pending.triedCandidates) {
    pending.triedCandidates = true;
    const demodulator = new Demodulator(sr);
    const candidates = findSyncCandidates(full, approxSync, sr, {
      demodulator,
      range: 0.18,
      count: 6,
    });
    for (const candidate of candidates) {
      const header = readHeaderAt(full, candidate.offset, sr, demodulator);
      if (!header) continue;
      const alternate = readBodyAt(
        full,
        { ...header, demodulator },
        sr,
        demodulator,
      );
      if (alternate.ok) {
        acceptMessage(
          alternate.text,
          header.header,
          alternate.confidence,
          pending.callAbs,
        );
        return;
      }
    }
  }

  failPending("I heard the melody, but the words were too broken.");
}

/* ------------------------------------------------------------------ */
/* Sending                                                             */
/* ------------------------------------------------------------------ */

function resetTransmitProgress() {
  for (const stage of ui.transmitProgress.querySelectorAll("[data-stage]")) {
    stage.classList.remove("active", "done");
  }
}

function trackTransmit(rendered) {
  cancelAnimationFrame(state.txRaf);
  state.txStartedAt = performance.now();
  state.lastStatusPaint = 0;
  resetTransmitProgress();
  ui.transmitProgress.hidden = false;

  const stages = [...ui.transmitProgress.querySelectorAll("[data-stage]")].map(
    (element) => ({
      element,
      timeline: rendered.timeline.find(
        (stage) => stage.name === element.dataset.stage,
      ),
    }),
  );

  const paint = () => {
    const elapsed = (performance.now() - state.txStartedAt) / 1000;
    for (const stage of stages) {
      if (!stage.timeline) continue;
      const active =
        elapsed >= stage.timeline.start && elapsed < stage.timeline.end;
      const done = elapsed >= stage.timeline.end;
      stage.element.classList.toggle("active", active);
      stage.element.classList.toggle("done", done && !active);
    }

    if (engine.transmitting) {
      const now = performance.now();
      if (now - state.lastStatusPaint > 180) {
        const remaining = Math.max(0, rendered.end - elapsed);
        setStatus(`Singing · ${remaining.toFixed(1)}s`, "singing");
        state.lastStatusPaint = now;
      }
      state.txRaf = requestAnimationFrame(paint);
    } else {
      for (const stage of stages) {
        stage.element.classList.remove("active");
        stage.element.classList.add("done");
      }
    }
  };
  paint();
}

async function transmitText(text, { success = "Sent into the room." } = {}) {
  if (engine.transmitting) {
    showToast("Give the speaker a moment to finish.");
    return false;
  }
  const bytes = encoder.encode(text).length;
  if (bytes === 0) return false;
  if (bytes > MAX_PAYLOAD_BYTES) {
    showToast(`That is ${bytes} bytes; the limit is ${MAX_PAYLOAD_BYTES}.`);
    return false;
  }

  state.pending = null;
  try {
    await engine.ensureContext();
    const packet = buildPacket(text);
    const rendered = synthesizePacket(packet, engine.sampleRate);
    const finished = engine.playSamples(rendered.samples);
    // playSamples yields once while it settles the AudioContext; let it set
    // transmitting before the progress clock starts.
    await Promise.resolve();
    trackTransmit(rendered);
    await finished;
    engine.clearInput();
    state.lastCallAt = -Infinity;
    ui.transmitProgress.hidden = true;
    resetTransmitProgress();
    if (engine.listening) {
      setListenMessage("Sent. Listening again…", "is-listening");
    }
    showToast(success);
    return true;
  } catch (error) {
    console.error(error);
    cancelAnimationFrame(state.txRaf);
    ui.transmitProgress.hidden = true;
    resetTransmitProgress();
    showToast(error.message || "The sound could not be made.");
    return false;
  } finally {
    cancelAnimationFrame(state.txRaf);
    updateCompose();
  }
}

async function sendComposedText() {
  const text = ui.input.value;
  if (!text.trim()) {
    showToast("Write something first.");
    return;
  }
  await transmitText(text);
}

/* ------------------------------------------------------------------ */
/* Microphone                                                          */
/* ------------------------------------------------------------------ */

async function toggleMicrophone() {
  if (engine.listening) {
    engine.stopListening();
    state.pending = null;
    setStatus("Microphone off", "off");
    setListenMessage(
      "The microphone is closed. Open it to let this computer listen for a call.",
      "",
    );
    ui.scopeTitle.textContent = "Room tone";
    return;
  }

  ui.micButton.disabled = true;
  try {
    await engine.startListening();
    state.pending = null;
    state.lastCallAt = -Infinity;
    if (!window.isSecureContext) {
      showToast("The microphone needs localhost or HTTPS.");
    } else {
      showToast("Microphone open. Listening for a call.");
    }
    setStatus("Listening · mic open", "listening");
    setListenMessage(
      "Listening for the two-tone call. Keep this window open.",
      "is-listening",
    );
    ui.scopeTitle.textContent = "Listening";
  } catch (error) {
    console.error(error);
    engine.stopListening();
    const message =
      error.name === "NotAllowedError"
        ? "Microphone permission was refused."
        : error.name === "NotFoundError"
          ? "No microphone was found."
          : "The microphone could not be opened.";
    setStatus("Microphone closed", "off");
    setListenMessage(
      `${message} Lilt needs microphone access to hear another computer.`,
      "",
    );
    showToast(message);
  } finally {
    ui.micButton.disabled = false;
    updateMicButton();
  }
}

/* ------------------------------------------------------------------ */
/* Tone field                                                          */
/* ------------------------------------------------------------------ */

function spectrumLevels(spectrum, sampleRate) {
  const levels = new Float32Array(TONE_FREQS.length);
  if (!spectrum || spectrum.length === 0) return levels;
  for (let tone = 0; tone < TONE_FREQS.length; tone += 1) {
    const exact =
      (TONE_FREQS[tone] / (sampleRate / 2)) * (spectrum.length - 1);
    const from = Math.max(0, Math.floor(exact) - 1);
    const to = Math.min(spectrum.length - 1, Math.ceil(exact) + 1);
    let db = -Infinity;
    for (let i = from; i <= to; i += 1) {
      if (spectrum[i] > db) db = spectrum[i];
    }
    // -94 dB is the floor; -24 dB is a strong, close syllable.
    levels[tone] = Math.max(0, Math.min(1, (db + 94) / 70));
  }
  return levels;
}

function paintScope() {
  const canvas = ui.scopeCanvas;
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const live = spectrumLevels(engine.spectrum(), engine.sampleRate);
  const target = engine.listening || engine.transmitting ? live : new Float32Array(TONE_FREQS.length);
  for (let i = 0; i < state.barLevels.length; i += 1) {
    const current = state.barLevels[i];
    const goal = target[i];
    state.barLevels[i] = current + (goal - current) * (goal > current ? 0.34 : 0.14);
  }

  const maxLevel = Math.max(...state.barLevels);
  if (maxLevel > 0.055) {
    ui.scopeIdle.classList.add("hidden");
  } else if (!engine.transmitting) {
    ui.scopeIdle.classList.remove("hidden");
  }

  const left = 2;
  const right = width - 2;
  const top = 10;
  const baseline = height - 26;
  const fieldHeight = baseline - top;
  const slot = (right - left) / TONE_FREQS.length;
  const barWidth = Math.max(2, slot * 0.42);

  ctx.save();
  ctx.strokeStyle = "rgba(13, 17, 13, 0.13)";
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 5]);
  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = baseline - fieldHeight * fraction;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = "rgba(13, 17, 13, 0.3)";
  ctx.beginPath();
  ctx.moveTo(left, baseline + 0.5);
  ctx.lineTo(right, baseline + 0.5);
  ctx.stroke();

  for (let i = 0; i < TONE_FREQS.length; i += 1) {
    const level = state.barLevels[i];
    const h = Math.max(1.5, level * fieldHeight);
    const x = left + i * slot + (slot - barWidth) / 2;
    const y = baseline - h;

    const gradient = ctx.createLinearGradient(0, baseline, 0, top);
    gradient.addColorStop(0, "rgba(33, 43, 18, 0.84)");
    gradient.addColorStop(0.75, "rgba(44, 59, 18, 0.95)");
    gradient.addColorStop(1, "#93b329");
    ctx.fillStyle = gradient;

    ctx.beginPath();
    const radius = Math.min(barWidth / 2, 3);
    if (typeof ctx.roundRect === "function") {
      ctx.roundRect(x, y, barWidth, h, [radius, radius, 1, 1]);
    } else {
      ctx.rect(x, y, barWidth, h);
    }
    ctx.fill();

    if (level > 0.1) {
      ctx.fillStyle = "rgba(147, 179, 41, 0.9)";
      ctx.beginPath();
      ctx.arc(x + barWidth / 2, Math.max(top, y + 1), 1.6, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = "rgba(71, 75, 58, 0.78)";
    ctx.font = '8px "SFMono-Regular", Menlo, monospace';
    ctx.textAlign = "center";
    ctx.fillText(i.toString(16).toUpperCase(), x + barWidth / 2, baseline + 15);
  }

  ctx.restore();
  requestAnimationFrame(paintScope);
}

function updateMicLevel() {
  if (!engine.listening || engine.transmitting) {
    ui.levelBar.style.width = "0%";
    return;
  }
  const level = engine.micLevel();
  const percent = Math.max(0, Math.min(100, Math.round(Math.sqrt(level) * 145)));
  ui.levelBar.style.width = `${percent}%`;
}

/* ------------------------------------------------------------------ */
/* About                                                               */
/* ------------------------------------------------------------------ */

function buildToneTable() {
  const fragment = document.createDocumentFragment();
  TONE_FREQS.forEach((frequency, index) => {
    const chip = document.createElement("div");
    chip.className = "tone-chip";
    if (index === 0 || index === TONE_FREQS.length - 1) chip.classList.add("edge");
    const hex = document.createElement("b");
    hex.textContent = index.toString(16).toUpperCase();
    const hz = document.createElement("span");
    hz.textContent = `${frequency}`;
    chip.append(hex, hz);
    fragment.append(chip);
  });
  ui.toneTable.append(fragment);
}

function openAbout() {
  if (typeof ui.aboutDialog.showModal === "function") {
    ui.aboutDialog.showModal();
  } else {
    ui.aboutDialog.setAttribute("open", "");
  }
}

function closeAbout() {
  if (typeof ui.aboutDialog.close === "function") {
    ui.aboutDialog.close();
  } else {
    ui.aboutDialog.removeAttribute("open");
  }
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

ui.input.addEventListener("input", updateCompose);
ui.input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    if (!ui.sendButton.disabled) sendComposedText();
  }
});

ui.sendButton.addEventListener("click", sendComposedText);
ui.micButton.addEventListener("click", toggleMicrophone);
ui.clearButton.addEventListener("click", () => {
  resetMessages();
  showToast("The message tray is empty.");
});
ui.volumeInput.addEventListener("input", () => {
  engine.setVolume(Number(ui.volumeInput.value) / 100);
});
ui.aboutButton.addEventListener("click", openAbout);
ui.closeAbout.addEventListener("click", closeAbout);
ui.aboutDialog.addEventListener("click", (event) => {
  if (event.target === ui.aboutDialog) closeAbout();
});
ui.sampleButton.addEventListener("click", async () => {
  closeAbout();
  await transmitText("This is Lilt: a sentence folded into sixteen small tones.", {
    success: "Sample sent through the air.",
  });
});

window.addEventListener("beforeunload", () => engine.stopListening());

buildToneTable();
updateCompose();
updateReceiveMeta();
updateMicButton();
paintScope();

window.setInterval(tick, 110);
window.setInterval(updateMicLevel, 90);
