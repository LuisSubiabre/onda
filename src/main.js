// Onda — reproductor de MP3 minimalista
// Funciona dentro de Tauri (rutas de archivo reales) y también en un navegador
// normal para pruebas (archivos elegidos con <input type="file">).

const TAURI = window.__TAURI__ || null;
const STORAGE_KEY = "onda.state.v1";

const $ = (id) => document.getElementById(id);
const els = {
  list: $("list"), empty: $("empty"), add: $("add"), clear: $("clear"),
  play: $("play"), prev: $("prev"), next: $("next"), mode: $("mode"), autoplay: $("autoplay"),
  seek: $("seek"), cur: $("t-cur"), dur: $("t-dur"), vol: $("vol"), mute: $("mute"),
  nowTitle: $("now-title"), nowSub: $("now-sub"), nowMeta: $("now-meta"),
  drop: $("drop"), toast: $("toast"), spectrum: $("spectrum"),
};

const audio = new Audio();
audio.preload = "auto";
audio.crossOrigin = "anonymous"; // necesario para que el espectro pueda leer el audio

// Estado
let tracks = [];        // { id, path, url, name, artist, mode: "once" | "loop", duration, error }
let current = -1;       // índice de la pista cargada
let autoplay = true;    // pasar a la siguiente al terminar una pista "una vez"
let volume = 0.8;
let muted = false;
let seeking = false;
let uid = 0;

// ---------- Utilidades ----------
const fmt = (s) => {
  if (!isFinite(s) || s < 0) return "0:00";
  s = Math.floor(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};

function parseName(filename) {
  const base = filename.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const parts = base.split(" - ");
  if (parts.length >= 2) return { artist: parts[0].trim(), name: parts.slice(1).join(" - ").trim() };
  return { artist: "", name: base.trim() };
}

function setRangeFill(input) {
  const p = ((input.value - input.min) / (input.max - input.min)) * 100;
  input.style.setProperty("--p", `${p}%`);
}

let toastTimer;
function toast(msg) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
}

const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---------- Persistencia ----------
function save() {
  if (!TAURI) return; // en el navegador las URLs de blob no sobreviven a recargar
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      tracks: tracks.map(({ path, mode, duration, bpm, key }) => ({ path, mode, duration, bpm, key })),
      current, autoplay, volume, muted,
    }));
  } catch {}
}

function load() {
  if (!TAURI) return;
  try {
    const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!s) return;
    autoplay = s.autoplay ?? true;
    volume = s.volume ?? 0.8;
    muted = s.muted ?? false;
    tracks = (s.tracks || []).map((t) => Object.assign(makeTrack(t.path, null, t.mode, t.duration), {
      bpm: t.bpm ?? null, key: t.key ?? null, analyzed: t.bpm !== undefined || t.key !== undefined,
    }));
    current = Math.min(s.current ?? -1, tracks.length - 1);
    if (current >= 0) {
      audio.src = tracks[current].url;
      audio.loop = tracks[current].mode === "loop";
    }
  } catch {}
}

// ---------- Pistas ----------
function makeTrack(path, url, mode = "once", duration = null) {
  const { name, artist } = parseName(path);
  return {
    id: ++uid, path, name, artist, mode, duration, error: false,
    bpm: null, key: null, analyzed: false,
    url: url || (TAURI ? TAURI.core.convertFileSrc(path) : path),
  };
}

function addPaths(paths) {
  const mp3 = paths.filter((p) => /\.mp3$/i.test(p));
  if (!mp3.length) { toast("Solo se pueden agregar archivos MP3"); return; }
  const before = tracks.length;
  tracks.push(...mp3.map((p) => makeTrack(p)));
  afterAdd(before, mp3.length);
}

function addFiles(files) {
  const mp3 = [...files].filter((f) => /\.mp3$/i.test(f.name) || f.type === "audio/mpeg");
  if (!mp3.length) { toast("Solo se pueden agregar archivos MP3"); return; }
  const before = tracks.length;
  tracks.push(...mp3.map((f) => makeTrack(f.name, URL.createObjectURL(f))));
  afterAdd(before, mp3.length);
}

function afterAdd(before, count) {
  toast(count === 1 ? "1 pista agregada" : `${count} pistas agregadas`);
  render();
  save();
  probeDurations();
  analyzeQueue();
  if (before === 0 && current === -1) select(0, false);
}

function removeTrack(i) {
  const wasCurrent = i === current;
  const t = tracks[i];
  if (t.url.startsWith("blob:")) URL.revokeObjectURL(t.url);
  tracks.splice(i, 1);
  if (wasCurrent) {
    const playing = !audio.paused;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    current = -1;
    if (tracks.length) select(Math.min(i, tracks.length - 1), playing);
  } else if (i < current) {
    current--;
  }
  render();
  save();
}

function clearAll() {
  if (!tracks.length) return;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  tracks.forEach((t) => t.url.startsWith("blob:") && URL.revokeObjectURL(t.url));
  tracks = [];
  current = -1;
  render();
  save();
}

// Lee la duración de cada pista sin reproducirla
let probing = false;
async function probeDurations() {
  if (probing) return;
  probing = true;
  const probe = new Audio();
  probe.preload = "metadata";
  for (const t of tracks) {
    if (t.duration != null || t.error) continue;
    await new Promise((resolve) => {
      const done = () => { probe.onloadedmetadata = probe.onerror = null; resolve(); };
      probe.onloadedmetadata = () => { t.duration = probe.duration; done(); };
      probe.onerror = () => { t.error = true; done(); };
      probe.src = t.url;
    });
    updateRow(t);
  }
  probe.removeAttribute("src");
  probing = false;
  save();
}

// ---------- Análisis de BPM y tonalidad ----------
const NOTES = ["Do", "Do♯", "Re", "Mi♭", "Mi", "Fa", "Fa♯", "Sol", "La♭", "La", "Si♭", "Si"];
const NOTES_EN = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

function camelot(key) {
  const major = key.minor ? (key.tonic + 3) % 12 : key.tonic; // relativa mayor
  return `${((major * 7 + 7) % 12) + 1}${key.minor ? "A" : "B"}`;
}
const keyShort = (k) => `${NOTES_EN[k.tonic]}${k.minor ? "m" : ""}`;
const keyLong = (k) => `${NOTES[k.tonic]} ${k.minor ? "menor" : "mayor"}`;

const ANALYSIS_RATE = 11025;   // basta para ritmo y notas, y es 4 veces más liviano
const ANALYSIS_SECONDS = 60;   // se analiza un minuto del centro de la canción
let worker = null;
let analyzing = null;          // pista en análisis
const workerJobs = new Map();

function getWorker() {
  if (!worker) {
    worker = new Worker("analyzer.js");
    worker.onmessage = (e) => {
      const job = workerJobs.get(e.data.id);
      if (job) { workerJobs.delete(e.data.id); job(e.data); }
    };
  }
  return worker;
}

async function analyzeTrack(t) {
  const data = await (await fetch(t.url)).arrayBuffer();
  const decoded = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(data);
  const len = Math.min(ANALYSIS_SECONDS, decoded.duration);
  const offset = Math.max(0, (decoded.duration - len) * 0.4);
  const off = new OfflineAudioContext(1, Math.ceil(len * ANALYSIS_RATE), ANALYSIS_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start(0, offset, len);
  const rendered = await off.startRendering();
  const samples = rendered.getChannelData(0).slice();
  return new Promise((resolve) => {
    workerJobs.set(t.id, resolve);
    getWorker().postMessage({ id: t.id, samples, sampleRate: ANALYSIS_RATE }, [samples.buffer]);
  });
}

// Analiza de a una pista; primero la que está sonando
async function analyzeQueue() {
  if (analyzing) return;
  while (true) {
    const pending = (t) => !t.analyzed && !t.error;
    const t = (tracks[current] && pending(tracks[current])) ? tracks[current] : tracks.find(pending);
    if (!t) break;
    analyzing = t;
    updateRow(t);
    if (t === tracks[current]) renderPlayer();
    try {
      const res = await analyzeTrack(t);
      t.bpm = res.bpm ?? null;
      t.key = res.key ?? null;
    } catch (err) {
      console.warn("No se pudo analizar", t.path, err);
    }
    t.analyzed = true;
    analyzing = null;
    if (tracks.includes(t)) {
      updateRow(t);
      if (t === tracks[current]) renderPlayer();
      save();
    }
  }
}

function metaText(t) {
  if (!t.analyzed) return analyzing === t ? "analizando…" : "";
  const parts = [];
  if (t.bpm) parts.push(`${Math.round(t.bpm)} BPM`);
  if (t.key) parts.push(keyShort(t.key));
  return parts.join(" · ");
}

// ---------- Espectro ----------
let audioCtx = null, analyser = null, gainNode = null, freqData = null;
const BARS = 64;
const barLevels = new Float32Array(BARS);
const barPeaks = new Float32Array(BARS);
let barEdges = null;
let rafId = 0;

function ensureAudioGraph() {
  if (audioCtx) { if (audioCtx.state === "suspended") audioCtx.resume(); return; }
  try {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaElementSource(audio);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 4096;
    analyser.smoothingTimeConstant = 0.72;
    analyser.minDecibels = -90;
    analyser.maxDecibels = -20;
    gainNode = audioCtx.createGain();
    // El espectro se toma antes del volumen, así no cambia al bajarlo
    source.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(audioCtx.destination);
    applyVolume();
    freqData = new Uint8Array(analyser.frequencyBinCount);
    // Bandas logarítmicas de 35 Hz a 16 kHz
    const binHz = audioCtx.sampleRate / analyser.fftSize;
    barEdges = Array.from({ length: BARS + 1 }, (_, i) => {
      const f = 35 * Math.pow(16000 / 35, i / BARS);
      return Math.max(1, Math.round(f / binHz));
    });
  } catch (err) {
    console.warn("Espectro no disponible", err);
  }
}

function startSpectrum() {
  if (!rafId) rafId = requestAnimationFrame(drawSpectrum);
}

function drawSpectrum() {
  rafId = 0;
  const c = els.spectrum;
  const dpr = window.devicePixelRatio || 1;
  const w = c.clientWidth, h = c.clientHeight;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
  }
  const g = c.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const live = analyser && !audio.paused;
  const css = getComputedStyle(document.documentElement);
  const colors = {
    a1: css.getPropertyValue("--accent").trim(),
    a2: css.getPropertyValue("--accent-2").trim(),
    faint: css.getPropertyValue("--faint").trim(),
  };
  const active = vizMode === "wave" ? drawWave(g, w, h, live, colors) : drawBars(g, w, h, live, colors);
  if (live || active) startSpectrum();
}

// ---------- Osciloscopio (ondas) ----------
let timeData = null;
const WAVE_POINTS = 512;
const waveShape = new Float32Array(WAVE_POINTS);
let waveEnv = 0.3;

function drawWave(g, w, h, live, { a1, a2, faint }) {
  let active = false;
  if (live) {
    if (!timeData || timeData.length !== analyser.fftSize) timeData = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(timeData);
    // Buscar un cruce por cero ascendente para que la onda se vea quieta
    let start = 0;
    const span = Math.min(timeData.length - WAVE_POINTS * 2, timeData.length / 2);
    for (let i = 1; i < span; i++) {
      if (timeData[i - 1] < 0 && timeData[i] >= 0) { start = i; break; }
    }
    // Ganancia automática: grabaciones suaves también llenan la franja
    let peak = 0;
    for (let i = 0; i < timeData.length; i++) peak = Math.max(peak, Math.abs(timeData[i]));
    waveEnv = Math.max(peak, waveEnv * 0.985);
    const gain = 0.9 / Math.max(waveEnv, 0.04);
    for (let i = 0; i < WAVE_POINTS; i++) {
      const v = (timeData[start + i * 2] || 0) * gain;
      waveShape[i] = waveShape[i] * 0.35 + v * 0.65; // suavizado leve entre cuadros
    }
  } else {
    for (let i = 0; i < WAVE_POINTS; i++) waveShape[i] *= 0.85; // se aplana al pausar
  }
  for (let i = 0; i < WAVE_POINTS; i++) if (Math.abs(waveShape[i]) > 0.002) { active = true; break; }

  const mid = h / 2;
  const amp = h / 2 - 4;

  // línea central tenue
  g.fillStyle = faint;
  g.fillRect(0, Math.round(mid), w, 1);

  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, a1); grad.addColorStop(1, a2);

  const path = () => {
    g.beginPath();
    for (let i = 0; i < WAVE_POINTS; i++) {
      const x = (i / (WAVE_POINTS - 1)) * w;
      const y = mid - Math.max(-1, Math.min(1, waveShape[i])) * amp;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
  };
  g.lineJoin = "round";
  g.lineCap = "round";
  // brillo suave detrás
  path();
  g.strokeStyle = grad;
  g.globalAlpha = 0.25;
  g.lineWidth = 6;
  g.stroke();
  // trazo principal
  g.globalAlpha = 1;
  g.lineWidth = 2;
  g.stroke();
  return active;
}

// ---------- Barras (espectro) ----------
function drawBars(g, w, h, live, { a1, a2, faint }) {
  if (live) analyser.getByteFrequencyData(freqData);

  let active = false;
  for (let i = 0; i < BARS; i++) {
    let v = 0;
    if (live) {
      let lo = barEdges[i], hi = Math.max(barEdges[i + 1], lo + 1);
      for (let k = lo; k < hi && k < freqData.length; k++) v = Math.max(v, freqData[k]);
      v /= 255;
    }
    // Subida rápida, bajada suave
    barLevels[i] = v > barLevels[i] ? v : barLevels[i] * 0.88;
    barPeaks[i] = Math.max(barLevels[i], barPeaks[i] - 0.012);
    if (barLevels[i] > 0.002 || barPeaks[i] > 0.002) active = true;
  }

  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, a1); grad.addColorStop(1, a2);

  const gap = 3;
  const bw = Math.max(1, (w - gap * (BARS - 1)) / BARS);
  for (let i = 0; i < BARS; i++) {
    const x = i * (bw + gap);
    // base tenue para que el espectro se vea aunque esté en silencio
    g.fillStyle = faint;
    g.fillRect(x, h - 2, bw, 2);
    const bh = Math.max(0, barLevels[i] * (h - 6));
    if (bh > 1) {
      g.fillStyle = grad;
      g.globalAlpha = 0.85;
      roundTop(g, x, h - bh, bw, bh, Math.min(3, bw / 2));
      g.globalAlpha = 1;
    }
    const py = h - barPeaks[i] * (h - 6) - 3;
    if (barPeaks[i] > 0.02) { g.fillStyle = a1; g.fillRect(x, py, bw, 2); }
  }
  return active;
}

// ---------- Selector de visualización ----------
const VIZ_KEY = "onda.viz";
let vizMode = (() => { try { return localStorage.getItem(VIZ_KEY) === "wave" ? "wave" : "bars"; } catch { return "bars"; } })();

function setVizMode(mode) {
  vizMode = mode;
  try { localStorage.setItem(VIZ_KEY, mode); } catch {}
  document.querySelectorAll(".viz-switch button").forEach((b) => b.classList.toggle("on", b.dataset.viz === mode));
  startSpectrum();
}
document.querySelectorAll(".viz-switch button").forEach((b) => b.addEventListener("click", (e) => {
  e.stopPropagation();
  setVizMode(b.dataset.viz);
}));
els.spectrum.addEventListener("click", () => setVizMode(vizMode === "bars" ? "wave" : "bars"));
setVizMode(vizMode);

function roundTop(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x, y + h);
  g.lineTo(x, y + r);
  g.quadraticCurveTo(x, y, x + r, y);
  g.lineTo(x + w - r, y);
  g.quadraticCurveTo(x + w, y, x + w, y + r);
  g.lineTo(x + w, y + h);
  g.fill();
}

window.addEventListener("resize", startSpectrum);

// ---------- Reproducción ----------
function select(i, play = true) {
  if (i < 0 || i >= tracks.length) return;
  current = i;
  const t = tracks[i];
  audio.src = t.url;
  audio.loop = t.mode === "loop";
  if (play) audio.play().catch(() => {});
  analyzeQueue();
  render();
  save();
}

function togglePlay() {
  if (!tracks.length) { pickFiles(); return; }
  if (current === -1) { select(0); return; }
  if (audio.paused) audio.play().catch(() => {});
  else audio.pause();
}

function next(fromEnded = false) {
  if (!tracks.length) return;
  if (current < tracks.length - 1) select(current + 1, fromEnded || !audio.paused);
  else if (!fromEnded) select(0, !audio.paused);
}

function prev() {
  if (!tracks.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; return; }
  select(current > 0 ? current - 1 : 0, !audio.paused);
}

function setMode(i, mode) {
  const t = tracks[i];
  if (!t) return;
  t.mode = mode ?? (t.mode === "loop" ? "once" : "loop");
  if (i === current) audio.loop = t.mode === "loop";
  toast(t.mode === "loop" ? "En bucle: se repite esta pista" : "Una vez: suena y continúa");
  render();
  save();
}

audio.addEventListener("ended", () => {
  // Las pistas en bucle nunca llegan aquí (audio.loop = true)
  if (autoplay && current < tracks.length - 1) next(true);
  else { audio.currentTime = 0; renderPlayer(); }
});

audio.addEventListener("error", () => {
  if (current < 0 || !audio.getAttribute("src")) return;
  tracks[current].error = true;
  toast("No se pudo reproducir esta pista");
  render();
  if (autoplay && current < tracks.length - 1) next(true);
});

["play", "pause"].forEach((e) => audio.addEventListener(e, () => { renderPlayer(); renderListState(); startSpectrum(); }));
audio.addEventListener("play", ensureAudioGraph);
audio.addEventListener("loadedmetadata", () => {
  if (current >= 0 && !tracks[current].duration) { tracks[current].duration = audio.duration; updateRow(tracks[current]); }
  renderTime();
});
audio.addEventListener("timeupdate", renderTime);

// ---------- Render ----------
function render() {
  els.empty.classList.toggle("show", tracks.length === 0);
  els.list.innerHTML = tracks.map((t, i) => rowHtml(t, i)).join("");
  renderPlayer();
}

function rowHtml(t, i) {
  const active = i === current;
  const num = active
    ? `<span class="bars${audio.paused ? " paused" : ""}"><i></i><i></i><i></i></span>`
    : i + 1;
  const loop = t.mode === "loop";
  return `
    <li class="row${active ? " active" : ""}${t.error ? " error" : ""}" data-i="${i}" data-id="${t.id}">
      <span class="num">${num}</span>
      <div class="title-cell">
        <div class="t-name" title="${escapeHtml(t.path)}">${escapeHtml(t.name)}</div>
        ${t.artist ? `<div class="t-artist">${escapeHtml(t.artist)}</div>` : ""}
      </div>
      <span class="meta${t.analyzed ? "" : " pending"}">${metaText(t)}</span>
      <span class="dur">${t.error ? "error" : t.duration != null ? fmt(t.duration) : ""}</span>
      <button class="chip mode${loop ? " on" : ""}" data-act="mode" title="${loop ? "En bucle (clic: una vez)" : "Una vez (clic: en bucle)"}">${icon(loop ? "loop" : "once")}</button>
      <button class="chip rm" data-act="rm" title="Quitar de la lista">${icon("x")}</button>
    </li>`;
}

function updateRow(t) {
  const li = els.list.querySelector(`[data-id="${t.id}"]`);
  if (li) li.outerHTML = rowHtml(t, tracks.indexOf(t));
}

function renderListState() {
  const bars = els.list.querySelector(".bars");
  if (bars) bars.classList.toggle("paused", audio.paused);
}

function renderPlayer() {
  const t = tracks[current];
  els.nowTitle.textContent = t ? t.name : "Nada sonando";
  els.nowSub.textContent = t ? (t.artist || (t.mode === "loop" ? "En bucle" : "Una vez")) : (tracks.length ? "Elige una pista" : "—");
  let meta = "";
  if (t && t.analyzed) {
    if (t.bpm) meta += `<span class="tag">${Math.round(t.bpm)} BPM</span>`;
    if (t.key) meta += `<span class="tag" title="Confianza ${Math.round((t.key.confidence || 0) * 100)}%">${keyLong(t.key)} · ${camelot(t.key)}</span>`;
  } else if (t && analyzing === t) {
    meta = `<span class="tag dim">Analizando BPM y tonalidad…</span>`;
  }
  els.nowMeta.innerHTML = meta;

  els.play.innerHTML = icon(audio.paused ? "play" : "pause");
  els.play.title = audio.paused ? "Reproducir (Espacio)" : "Pausar (Espacio)";

  const loop = t && t.mode === "loop";
  els.mode.innerHTML = icon(loop ? "loop" : "once");
  els.mode.classList.toggle("on", !!loop);
  els.mode.disabled = !t;
  els.mode.title = loop ? "Pista en bucle — clic para reproducir una vez" : "Pista una vez — clic para ponerla en bucle";

  els.autoplay.classList.toggle("on", autoplay);
  els.autoplay.title = autoplay ? "Reproducción automática: activada" : "Reproducción automática: desactivada";

  els.prev.disabled = els.next.disabled = !tracks.length;
  els.mute.innerHTML = icon(muted || volume === 0 ? "mute" : "vol");
  els.seek.disabled = !t;

  if ("mediaSession" in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.name, artist: t.artist || "Onda" });
    navigator.mediaSession.playbackState = audio.paused ? "paused" : "playing";
  }
  renderTime();
}

function renderTime() {
  const d = audio.duration;
  els.cur.textContent = fmt(audio.currentTime);
  els.dur.textContent = fmt(d);
  if (!seeking) {
    els.seek.value = isFinite(d) && d > 0 ? Math.round((audio.currentTime / d) * 1000) : 0;
    setRangeFill(els.seek);
  }
}

// ---------- Archivos ----------
const fileInput = Object.assign(document.createElement("input"), { type: "file", accept: ".mp3,audio/mpeg", multiple: true });
fileInput.addEventListener("change", () => { addFiles(fileInput.files); fileInput.value = ""; });

async function pickFiles() {
  if (TAURI) {
    const res = await TAURI.dialog.open({ multiple: true, filters: [{ name: "MP3", extensions: ["mp3"] }] });
    if (res) addPaths(Array.isArray(res) ? res : [res]);
  } else {
    fileInput.click();
  }
}

// Arrastrar y soltar desde el Explorador
if (TAURI) {
  TAURI.webviewWindow.getCurrentWebviewWindow().onDragDropEvent((e) => {
    const { type, paths } = e.payload;
    if (type === "enter" || type === "over") els.drop.classList.add("show");
    else els.drop.classList.remove("show");
    if (type === "drop" && paths?.length) addPaths(paths);
  });
} else {
  let depth = 0;
  window.addEventListener("dragenter", (e) => { e.preventDefault(); depth++; els.drop.classList.add("show"); });
  window.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; els.drop.classList.remove("show"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault(); depth = 0; els.drop.classList.remove("show");
    addFiles(e.dataTransfer.files);
  });
}

// ---------- Eventos de la interfaz ----------
els.add.addEventListener("click", pickFiles);
els.clear.addEventListener("click", clearAll);
els.play.addEventListener("click", togglePlay);
els.next.addEventListener("click", () => next());
els.prev.addEventListener("click", prev);
els.mode.addEventListener("click", () => setMode(current));
els.autoplay.addEventListener("click", () => {
  autoplay = !autoplay;
  toast(autoplay ? "Reproducción automática activada" : "Reproducción automática desactivada");
  renderPlayer();
  save();
});

els.list.addEventListener("click", (e) => {
  const li = e.target.closest(".row");
  if (!li) return;
  const i = +li.dataset.i;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "mode") setMode(i);
  else if (act === "rm") removeTrack(i);
});
els.list.addEventListener("dblclick", (e) => {
  if (e.target.closest("[data-act]")) return;
  const li = e.target.closest(".row");
  if (li) select(+li.dataset.i);
});

els.seek.addEventListener("input", () => {
  seeking = true;
  setRangeFill(els.seek);
  if (isFinite(audio.duration)) els.cur.textContent = fmt((els.seek.value / 1000) * audio.duration);
});
els.seek.addEventListener("change", () => {
  if (isFinite(audio.duration)) audio.currentTime = (els.seek.value / 1000) * audio.duration;
  seeking = false;
});

function applyVolume() {
  if (gainNode) {
    audio.volume = 1;
    audio.muted = false;
    gainNode.gain.value = muted ? 0 : volume * volume; // curva más natural al oído
  } else {
    audio.volume = volume * volume;
    audio.muted = muted;
  }
  els.vol.value = Math.round(volume * 100);
  setRangeFill(els.vol);
}
els.vol.addEventListener("input", () => {
  volume = els.vol.value / 100;
  muted = false;
  applyVolume();
  renderPlayer();
  save();
});
els.mute.addEventListener("click", () => { muted = !muted; applyVolume(); renderPlayer(); save(); });

// Atajos de teclado
window.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" && e.key !== " ") return;
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight" && e.ctrlKey) next();
  else if (e.key === "ArrowLeft" && e.ctrlKey) prev();
  else if (e.key === "ArrowRight" && current >= 0) audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || 0);
  else if (e.key === "ArrowLeft" && current >= 0) audio.currentTime = Math.max(audio.currentTime - 5, 0);
  else if (e.key.toLowerCase() === "l" && current >= 0) setMode(current);
  else if (e.key.toLowerCase() === "a") els.autoplay.click();
  else if (e.key.toLowerCase() === "v") setVizMode(vizMode === "bars" ? "wave" : "bars");
});

// Teclas multimedia del teclado / controles de Windows
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => audio.play());
  ms.setActionHandler("pause", () => audio.pause());
  ms.setActionHandler("nexttrack", () => next());
  ms.setActionHandler("previoustrack", prev);
}

// ---------- Inicio ----------
load();
applyVolume();
render();
probeDurations();
analyzeQueue();
startSpectrum();
