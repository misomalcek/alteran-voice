/* Alteran Voice — browser client. Mic -> /api/turn -> audio out. No frameworks. */
const $ = (id) => document.getElementById(id);
const log = $("log"), mic = $("mic"), viz = $("viz");
const modeToggle = $("modeToggle"), langToggle = $("langToggle");
const convIndicator = $("convIndicator"), convStateEl = $("convState");
let sessionId = null, recorder = null, chunks = [], stream = null;
let state = "idle"; // idle | rec | busy | speaking
let currentAudio = null, analyser = null, vizTimer = null, audioCtx = null;

/* Conversation mode state */
let convMode = false;
let convStream = null, convAnalyser = null, convAudioCtx = null;
let convVadTimer = null, convSilenceTimer = null, convSpeechTimer = null;
let convState = "idle"; // idle | listening | processing | speaking
let convAccumulator = [];
let convLastSpeech = 0;
let convMinSpeechMs = 300;
let convSilenceMs = 3000;
let convThreshold = 0.015; // RMS threshold for voice detection
let convMinRms = 0.002;

/* ---------- ambient mycelial field ---------- */
(() => {
  const cv = $("field"), ctx = cv.getContext("2d");
  let nodes = [], W, H;
  const resize = () => {
    W = cv.width = innerWidth; H = cv.height = innerHeight;
    const n = Math.min(70, Math.floor(W * H / 26000));
    nodes = Array.from({ length: n }, () => ({
      x: Math.random() * W, y: Math.random() * H,
      vx: (Math.random() - .5) * .22, vy: (Math.random() - .5) * .22,
    }));
  };
  resize(); addEventListener("resize", resize);
  (function draw() {
    ctx.clearRect(0, 0, W, H);
    for (const p of nodes) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > W) p.vx *= -1;
      if (p.y < 0 || p.y > H) p.vy *= -1;
    }
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i], b = nodes[j], d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < 150) {
        ctx.strokeStyle = `rgba(0,239,252,${(1 - d / 150) * .07})`;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      }
    }
    for (const p of nodes) {
      ctx.fillStyle = "rgba(0,255,157,.25)";
      ctx.fillRect(p.x, p.y, 1.6, 1.6);
    }
    requestAnimationFrame(draw);
  })();
})();

/* ---------- language state ---------- */
let currentLang = localStorage.getItem("alteran_lang") || "en";

function setLang(lang) {
  currentLang = lang;
  localStorage.setItem("alteran_lang", lang);
  document.querySelectorAll(".lang-btn").forEach(btn => {
    const isActive = btn.dataset.lang === lang;
    btn.classList.toggle("active", isActive);
    btn.setAttribute("aria-pressed", isActive);
  });
  document.documentElement.lang = lang;
  // Update placeholder text
  const textInput = $("text");
  if (lang === "sk") {
    textInput.placeholder = "…alebo napíš otázku";
  } else {
    textInput.placeholder = "…or type a question";
  }
}

/* ---------- conversation mode state ---------- */
function setConvMode(on) {
  convMode = on;
  modeToggle.classList.toggle("active", on);
  modeToggle.setAttribute("aria-pressed", on);
  convIndicator.hidden = !on;
  if (on) {
    startConversationMode();
  } else {
    stopConversationMode();
  }
}

/* ---------- health + voices ---------- */
async function health() {
  try {
    const r = await fetch("/api/health"); const d = await r.json();
    $("dot").className = "dot on";
    $("status").textContent = `${d.corpus.articles} articles · ${d.corpus.chunks} chunks indexed`;
    const sel = $("voice");
    for (const v of d.models.tts_voices) {
      const o = document.createElement("option");
      o.value = v; o.textContent = `voice: ${v}`;
      if (v === d.models.tts_default_voice) o.selected = true;
      sel.appendChild(o);
    }
  } catch {
    $("dot").className = "dot err"; $("status").textContent = "server unreachable";
  }
}
health();

/* ---------- UI helpers ---------- */
function setState(s) {
  state = s;
  mic.className = "mic" +
    (s === "rec" ? " rec" : s === "busy" ? " busy" : s === "speaking" ? " speaking" : "");
  mic.disabled = s === "busy";
}

function addMsg(who, text, extra) {
  const div = document.createElement("div");
  div.className = `msg ${who}` + (extra?.pending ? " pending" : "");
  div.innerHTML = `<div class="who">${who === "user" ? "YOU" : "ALTERAN"}</div><div class="bubble"></div>`;
  div.querySelector(".bubble").textContent = text;
  log.appendChild(div); log.scrollTop = log.scrollHeight;
  return div;
}

function decorate(div, d) {
  if (d.sources?.length) {
    const s = document.createElement("div"); s.className = "sources";
    for (const src of d.sources.slice(0, 4)) {
      const a = document.createElement("a");
      a.href = src.url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = src.title; s.appendChild(a);
    }
    div.appendChild(s);
  }
  const t = d.timings_ms || {};
  const meta = document.createElement("div");
  meta.className = "turnmeta mono";
  meta.textContent = [
    t.stt != null ? `stt ${t.stt}ms` : null,
    `retrieve ${t.retrieval}ms`, `think ${t.llm}ms`, `speak ${t.tts}ms`,
    d.tts_provider, d.llm_provider?.split("/")[0],
  ].filter(Boolean).join(" · ");
  div.appendChild(meta);
  $("timings").textContent = `last turn: ${t.total}ms`;
}

/* ---------- playback ---------- */
function stopSpeech() {
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  speechSynthesis?.cancel();
}

function playReply(d) {
  return new Promise((resolve) => {
    if (d.audio) {
      const a = new Audio(`data:${d.audio_mime};base64,${d.audio}`);
      currentAudio = a;
      a.onended = () => { currentAudio = null; resolve(); };
      a.onerror = () => { currentAudio = null; resolve(); };
      a.play().catch(resolve);
    } else if (window.speechSynthesis) {
      const u = new SpeechSynthesisUtterance(d.reply);
      u.lang = currentLang === "sk" ? "sk-SK" : "en-US";
      u.onend = resolve; u.onerror = resolve;
      speechSynthesis.speak(u);
    } else resolve();
  });
}

/* ---------- recording (push-to-talk) ---------- */
function buildViz() {
  viz.innerHTML = ""; viz.hidden = false;
  const bars = Array.from({ length: 32 }, () => { const i = document.createElement("i"); viz.appendChild(i); return i; });
  const data = new Uint8Array(analyser.frequencyBinCount);
  vizTimer = setInterval(() => {
    analyser.getByteFrequencyData(data);
    bars.forEach((b, i) => {
      const v = data[Math.floor(i * data.length / bars.length / 2)] || 0;
      b.style.height = `${Math.max(3, v / 7)}px`;
    });
  }, 60);
}

function teardownViz() { clearInterval(vizTimer); viz.hidden = true; }

async function startRec() {
  stopSpeech();
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    addMsg("alteran", "I cannot reach your microphone. Check permissions — or type below.");
    return;
  }
  audioCtx = audioCtx || new AudioContext();
  const src = audioCtx.createMediaStreamSource(stream);
  analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
  src.connect(analyser);
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
  recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = sendRecording;
  recorder.start(250);
  setState("rec"); buildViz();
  $("hint").textContent = "listening… click again (or Space) to send";
}

function stopRec() {
  if (recorder?.state === "recording") recorder.stop();
  stream?.getTracks().forEach((t) => t.stop());
  teardownViz();
}

async function sendRecording() {
  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  if (blob.size < 4000) { setState("idle"); $("hint").textContent = "too short — try again"; return; }
  const ext = (recorder.mimeType || "").includes("mp4") ? "m4a" : "webm";
  const fd = new FormData();
  fd.append("audio", blob, `turn.${ext}`);
  if (sessionId) fd.append("session_id", sessionId);
  fd.append("voice", $("voice").value || "tara");
  fd.append("lang", currentLang);
  await runTurn(fd, null);
}

/* ---------- turn ---------- */
async function runTurn(body, typedText) {
  setState("busy");
  const pending = addMsg("alteran", "…", { pending: true });
  $("hint").textContent = "thinking…";
  try {
    const r = await fetch("/api/turn", { method: "POST", body });
    const d = await r.json();
    pending.remove();
    if (!r.ok || d.error) {
      addMsg("alteran", `Something broke in the pipeline: ${d.error || r.statusText}`);
      setState("idle"); $("hint").textContent = "free tier · groq whisper + gpt-oss + orpheus · local bm25";
      return;
    }
    sessionId = d.session_id;
    addMsg("user", d.transcript);
    const div = addMsg("alteran", d.reply);
    decorate(div, d);
    setState("speaking");
    $("hint").textContent = "speaking… (click mic to interrupt)";
    await playReply(d);
    setState("idle");
    $("hint").textContent = "free tier · groq whisper + gpt-oss + orpheus · local bm25";
    // In conversation mode, restart listening after reply
    if (convMode && convState !== "idle") {
      setTimeout(() => {
        if (convMode) convState = "listening";
      }, 500);
    }
  } catch (e) {
    pending.remove();
    addMsg("alteran", `Network error: ${e.message}`);
    setState("idle");
  }
}

/* ---------- Conversation Mode: VAD ---------- */
function computeRMS(data) {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i] * data[i];
  }
  return Math.sqrt(sum / data.length) / 255; // Normalize to 0-1
}

function startConversationMode() {
  stopConversationMode(); // ensure clean
  convState = "listening";
  convAccumulator = [];
  convLastSpeech = Date.now();
  updateConvUI();

  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    .then(s => {
      convStream = s;
      convAudioCtx = new AudioContext();
      const src = convAudioCtx.createMediaStreamSource(s);
      convAnalyser = convAudioCtx.createAnalyser();
      convAnalyser.fftSize = 512;
      convAnalyser.smoothingTimeConstant = 0.3;
      src.connect(convAnalyser);

      const data = new Uint8Array(convAnalyser.frequencyBinCount);
      let wasSpeaking = false;

      const vadLoop = () => {
        if (!convMode) return;
        convAnalyser.getByteFrequencyData(data);
        const rms = computeRMS(data);
        const now = Date.now();
        const isSpeech = rms > convThreshold;

        if (isSpeech) {
          convLastSpeech = now;
          if (!wasSpeaking) {
            convSpeechTimer = now;
            wasSpeaking = true;
          }
        } else {
          wasSpeaking = false;
        }

        // Detect end of speech: silence after minimum speech duration
        const speechDuration = wasSpeaking ? (now - convSpeechTimer) : (now - convLastSpeech);
        const silenceDuration = now - convLastSpeech;

        if (wasSpeaking) {
          if (convState !== "listening") {
            convState = "listening";
            updateConvUI();
          }
        } else if (convState === "listening" && silenceDuration > convSilenceMs && (now - convSpeechTimer) > convMinSpeechMs) {
          // End of utterance detected
          convState = "processing";
          updateConvUI();
          captureAndSend();
          return; // stop loop, will restart after reply
        }

        convVadTimer = requestAnimationFrame(vadLoop);
      };

      vadLoop();
    })
    .catch(err => {
      console.error("Conv mode mic error:", err);
      addMsg("alteran", "Cannot start conversation mode — microphone access denied.");
      setConvMode(false);
    });
}

function stopConversationMode() {
  convMode = false;
  if (convVadTimer) cancelAnimationFrame(convVadTimer);
  convVadTimer = null;
  if (convStream) {
    convStream.getTracks().forEach(t => t.stop());
    convStream = null;
  }
  if (convAudioCtx) {
    convAudioCtx.close().catch(() => {});
    convAudioCtx = null;
  }
  convAnalyser = null;
  convState = "idle";
  updateConvUI();
  modeToggle.classList.remove("active");
  convIndicator.hidden = true;
}

function updateConvUI() {
  convIndicator.className = "conv-indicator " + convState;
  const labels = {
    listening: "listening…",
    processing: "thinking…",
    speaking: "speaking…",
    idle: "conversation mode"
  };
  if (convStateEl) convStateEl.textContent = labels[convState] || convState;
}

async function captureAndSend() {
  // We need to record the accumulated audio from the VAD stream
  // Since we're using a continuous stream, we'll record a chunk
  // For simplicity, we'll record a fresh short segment
  // In a more advanced version, we'd buffer the actual speech

  try {
    // Record a short segment to capture the utterance
    // This is a limitation - we'd ideally use the buffered audio
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const recorder = new MediaRecorder(convStream, mime ? { mimeType: mime } : undefined);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

    return new Promise((resolve) => {
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (blob.size < 1000) {
          convState = "listening";
          updateConvUI();
          resolve();
          return;
        }
        const ext = (recorder.mimeType || "").includes("mp4") ? "m4a" : "webm";
        const fd = new FormData();
        fd.append("audio", blob, `conv.${ext}`);
        if (sessionId) fd.append("session_id", sessionId);
        fd.append("voice", $("voice").value || "tara");
        fd.append("lang", currentLang);
        await runConversationTurn(fd);
        resolve();
      };
      recorder.start(200); // Record for 200ms to capture tail
      setTimeout(() => recorder.stop(), 500);
    });
  } catch (e) {
    console.error("Capture error:", e);
    convState = "listening";
    updateConvUI();
  }
}

async function runConversationTurn(body) {
  convState = "processing";
  updateConvUI();
  try {
    const r = await fetch("/api/turn", { method: "POST", body });
    const d = await r.json();
    if (!r.ok || d.error) {
      addMsg("alteran", `Pipeline error: ${d.error || r.statusText}`);
      convState = "listening";
      updateConvUI();
      return;
    }
    sessionId = d.session_id;
    addMsg("user", d.transcript);
    const div = addMsg("alteran", d.reply);
    decorate(div, d);
    convState = "speaking";
    updateConvUI();
    await playReply(d);
    // Back to listening
    if (convMode) {
      convState = "listening";
      updateConvUI();
      convLastSpeech = Date.now();
    }
  } catch (e) {
    addMsg("alteran", `Network error: ${e.message}`);
    convState = "listening";
    updateConvUI();
  }
}

/* ---------- events ---------- */
mic.addEventListener("click", () => {
  if (convMode) {
    // In conversation mode, click interrupts current speech
    if (convState === "speaking" || convState === "processing") {
      stopSpeech();
      convState = "listening";
      updateConvUI();
      convLastSpeech = Date.now();
    }
    return;
  }
  // Push-to-talk mode
  if (state === "rec") { stopRec(); }
  else if (state === "speaking") { stopSpeech(); setState("idle"); }
  else if (state === "idle") startRec();
});

document.addEventListener("keydown", (e) => {
  if (e.code === "Space" && document.activeElement !== $("text") && !e.repeat) {
    e.preventDefault();
    if (convMode) {
      if (convState === "speaking" || convState === "processing") {
        stopSpeech();
        convState = "listening";
        updateConvUI();
        convLastSpeech = Date.now();
      }
    } else {
      mic.click();
    }
  }
  if (e.code === "KeyC" && !e.repeat && document.activeElement !== $("text")) {
    e.preventDefault();
    setConvMode(!convMode);
  }
  if (e.code === "KeyL" && !e.repeat && document.activeElement !== $("text")) {
    e.preventDefault();
    setLang(currentLang === "en" ? "sk" : "en");
  }
});

$("textform").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("text").value.trim();
  if (!text || state === "busy") return;
  stopSpeech(); $("text").value = "";
  const fd = new FormData();
  fd.append("text", text);
  if (sessionId) fd.append("session_id", sessionId);
  fd.append("voice", $("voice").value || "tara");
  fd.append("lang", currentLang);
  runTurn(fd, text);
});

/* Simple click handlers - buttons work fine on mobile */
modeToggle.addEventListener("click", (e) => {
  e.preventDefault();
  setConvMode(!convMode);
});

langToggle.querySelectorAll(".lang-btn").forEach(btn => {
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setLang(btn.dataset.lang);
  });
});

$("reset").addEventListener("click", async () => {
  stopSpeech();
  if (convMode) setConvMode(false);
  if (sessionId) await fetch("/api/reset", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId }) });
  sessionId = null;
  log.innerHTML = "";
  const welcome = currentLang === "sk"
    ? "Nová sessia. Korpus si pamätá všetko; ja nič. Pýtaj sa."
    : "Fresh session. The corpus remembers everything; I remember nothing. Ask.";
  addMsg("alteran", welcome);
});

/* Initialize language */
setLang(currentLang);