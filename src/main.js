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
  nowCover: $("now-cover"), stopAfter: $("stopafter"), trimL: $("trim-l"), trimR: $("trim-r"),
  settings: $("settings"), settingsMenu: $("settings-menu"), fadeOpts: $("fade-opts"),
  trimDialog: $("trim-dialog"), trimTitle: $("trim-title"), trimCover: $("trim-cover"),
  trimStart: $("trim-start"), trimEnd: $("trim-end"), trimStartNow: $("trim-start-now"), trimEndNow: $("trim-end-now"),
  trimInfo: $("trim-info"), trimReset: $("trim-reset"), trimPreview: $("trim-preview"), trimDone: $("trim-done"),
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
let fadeSec = 1;        // fundido al pausar/reanudar y entre pistas
let stopAfter = false;  // detener al terminar la pista actual

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
      tracks: tracks.map(({ path, mode, duration, bpm, key, av, start, end, tags }) => ({ path, mode, duration, bpm, key, av, start, end, tags })),
      current, autoplay, volume, muted, fadeSec,
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
    fadeSec = s.fadeSec ?? 1;
    tracks = (s.tracks || []).map((t) => Object.assign(makeTrack(t.path, null, t.mode, t.duration), {
      bpm: t.bpm ?? null, key: t.key ?? null, av: t.av ?? 0, analyzed: t.av === ANALYSIS_VERSION,
      start: t.start ?? null, end: t.end ?? null, tags: t.tags ?? null,
    }));
    current = Math.min(s.current ?? -1, tracks.length - 1);
    if (current >= 0) loadSource(tracks[current]);
  } catch {}
}

// ---------- Pistas ----------
function makeTrack(path, url, mode = "once", duration = null) {
  const { name, artist } = parseName(path);
  return {
    id: ++uid, path, name, artist, mode, duration, error: false,
    bpm: null, key: null, analyzed: false,
    start: null, end: null,                 // recorte en segundos (null = sin recorte)
    tags: null, cover: null, tagsRead: false, // etiquetas ID3 y carátula
    url: url || (TAURI ? TAURI.core.convertFileSrc(path) : path),
  };
}

// Nombre y artista: primero las etiquetas del MP3, si no, el nombre del archivo
const titleOf = (t) => t.tags?.title || t.name;
function artistOf(t) {
  const g = t.tags;
  if (g?.artist) return g.artist;
  if (g?.albumArtist) return g.albumArtist;
  if (g?.composer) return g.composer;
  // Si el título está en el nombre del archivo ("Título - Artista"), la otra parte es el artista
  if (g?.title) {
    const norm = (s) => s.replace(/^[A-Z]{2}_/, "").trim().toLowerCase();
    const base = t.path.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
    const parts = base.split(" - ");
    const rest = parts.filter((p) => norm(p) !== norm(g.title));
    if (parts.length >= 2 && rest.length === parts.length - 1) return rest.join(" - ").trim();
  }
  return t.artist;
}

// BPM y tonalidad: si el archivo los trae en sus etiquetas, se usan esos
function tagBpm(t) {
  const v = parseFloat(t.tags?.bpm);
  return v > 20 && v < 300 ? v : null;
}
function tagKey(t) {
  const m = /^\s*([A-G])\s*([#♯b♭]?)\s*(m|min|minor|moll)?\s*$/i.exec(t.tags?.key || "");
  if (!m) return null;
  const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
  const acc = m[2] === "#" || m[2] === "♯" ? 1 : m[2] === "b" || m[2] === "♭" ? -1 : 0;
  return { tonic: (base + acc + 12) % 12, minor: !!m[3], fromTag: true };
}
const bpmOf = (t) => tagBpm(t) ?? t.bpm;
const keyOf = (t) => tagKey(t) ?? t.key;
const isTrimmed = (t) => t.start != null || t.end != null;
const coverHtml = (t) => t.cover ? `<img src="${t.cover}" alt="" draggable="false" />` : icon("note");

// Lee etiquetas y carátula de cada pista, de a una
let readingTags = false;
async function readTagsQueue() {
  if (readingTags) return;
  readingTags = true;
  try {
    const { readID3 } = await import("./id3.js");
    for (const t of tracks) {
      if (t.tagsRead) continue;
      t.tagsRead = true;
      try {
        const res = await readID3(t.url);
        if (res) {
          const { cover, ...text } = res;
          t.tags = text;
          if (cover) t.cover = URL.createObjectURL(cover);
        }
      } catch (err) {
        console.warn("No se pudieron leer las etiquetas", t.path, err);
      }
      if (tracks.includes(t)) {
        updateRow(t);
        if (t === tracks[current]) renderPlayer();
      }
    }
  } finally {
    readingTags = false;
  }
  save();
  if (tracks.some((t) => !t.tagsRead)) readTagsQueue();
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
  readTagsQueue();
  analyzeQueue();
  if (before === 0 && current === -1) select(0, false);
}

function removeTrack(i) {
  const wasCurrent = i === current;
  const t = tracks[i];
  if (t.url.startsWith("blob:")) URL.revokeObjectURL(t.url);
  if (t.cover) URL.revokeObjectURL(t.cover);
  tracks.splice(i, 1);
  if (wasCurrent) {
    const playing = !audio.paused;
    cancelFade();
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
  cancelFade();
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  tracks.forEach((t) => {
    if (t.url.startsWith("blob:")) URL.revokeObjectURL(t.url);
    if (t.cover) URL.revokeObjectURL(t.cover);
  });
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
const ANALYSIS_VERSION = 2;    // subirlo hace que se vuelvan a analizar las pistas guardadas
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
  // Canción completa en mono a 11 kHz (el worker toma lo que necesita)
  const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * ANALYSIS_RATE), ANALYSIS_RATE);
  const src = off.createBufferSource();
  src.buffer = decoded;
  src.connect(off.destination);
  src.start();
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
    t.av = ANALYSIS_VERSION;
    analyzing = null;
    if (tracks.includes(t)) {
      updateRow(t);
      if (t === tracks[current]) renderPlayer();
      save();
    }
  }
}

function metaText(t) {
  const bpm = bpmOf(t), key = keyOf(t);
  if (!t.analyzed && !(tagBpm(t) && tagKey(t))) {
    if (analyzing === t) return "analizando…";
    if (!bpm && !key) return "";
  }
  const parts = [];
  if (bpm) parts.push(`${Math.round(bpm)} BPM`);
  if (key) parts.push(keyShort(key));
  return parts.join(" · ");
}

// ---------- Espectro ----------
let audioCtx = null, analyser = null, gainNode = null, fadeGain = null, freqData = null;
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
    fadeGain = audioCtx.createGain();
    // El espectro se toma antes del volumen y del fundido, así no cambia con ellos
    source.connect(analyser);
    analyser.connect(fadeGain);
    fadeGain.connect(gainNode);
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
const QUICK_FADE = 0.12;   // fundido mínimo para evitar "clics" al pausar o cambiar
let pendingStart = null;   // posición a la que saltar cuando cargue la pista
let pendingFadeIn = null;  // fundido de entrada a aplicar cuando empiece a sonar
let pauseTimer = 0;
let fadeOutActive = false; // bajando el volumen en los últimos segundos de la pista

const isPlaying = () => !audio.paused && !pauseTimer;
const resumeFade = () => (fadeSec ? Math.min(fadeSec, 1.5) : QUICK_FADE);

function loadSource(t) {
  audio.src = t.url;
  // El bucle nativo no tiene cortes, pero solo sirve si la pista no está recortada
  audio.loop = t.mode === "loop" && !isTrimmed(t);
  pendingStart = t.start;
}

function rampTo(value, seconds) {
  if (!fadeGain) return;
  const g = fadeGain.gain, now = audioCtx.currentTime;
  g.cancelScheduledValues(now);
  g.setValueAtTime(g.value, now);
  g.linearRampToValueAtTime(value, now + Math.max(0.01, seconds));
}

function cancelFade() {
  clearTimeout(pauseTimer);
  pauseTimer = 0;
  fadeOutActive = false;
}

function playAudio(fadeIn = QUICK_FADE) {
  ensureAudioGraph();
  cancelFade();
  if (fadeGain) {
    fadeGain.gain.cancelScheduledValues(audioCtx.currentTime);
    fadeGain.gain.setValueAtTime(0, audioCtx.currentTime);
  }
  pendingFadeIn = fadeIn;
  if (!audio.paused) { rampTo(1, fadeIn); pendingFadeIn = null; }
  audio.play().catch(() => {});
  renderPlayer();
}

function pauseAudio() {
  if (audio.paused || pauseTimer) return;
  if (!fadeGain) { audio.pause(); return; }
  const d = resumeFade();
  rampTo(0, d);
  pauseTimer = setTimeout(() => { pauseTimer = 0; audio.pause(); }, d * 1000);
  renderPlayer();
}

function stopPlayback() {
  cancelFade();
  audio.pause();
  const t = tracks[current];
  audio.currentTime = t?.start ?? 0;
  renderPlayer();
}

function select(i, play = true, fadeIn = QUICK_FADE) {
  if (i < 0 || i >= tracks.length) return;
  cancelFade();
  current = i;
  loadSource(tracks[i]);
  if (play) playAudio(fadeIn);
  analyzeQueue();
  render();
  save();
}

function togglePlay() {
  if (!tracks.length) { pickFiles(); return; }
  if (current === -1) { select(0); return; }
  if (isPlaying()) pauseAudio();
  else playAudio(resumeFade());
}

function next(fromEnded = false) {
  if (!tracks.length) return;
  const play = fromEnded || isPlaying();
  const fadeIn = fromEnded && fadeSec ? fadeSec : QUICK_FADE;
  if (current < tracks.length - 1) select(current + 1, play, fadeIn);
  else if (!fromEnded) select(0, play);
}

function prev() {
  if (!tracks.length) return;
  const start = tracks[current]?.start ?? 0;
  if (audio.currentTime > start + 3) { audio.currentTime = start; return; }
  select(current > 0 ? current - 1 : 0, isPlaying());
}

function setMode(i, mode) {
  const t = tracks[i];
  if (!t) return;
  t.mode = mode ?? (t.mode === "loop" ? "once" : "loop");
  if (i === current) {
    audio.loop = t.mode === "loop" && !isTrimmed(t);
    if (t.mode === "loop" && fadeOutActive) { fadeOutActive = false; rampTo(1, QUICK_FADE); }
  }
  toast(t.mode === "loop" ? "En bucle: se repite esta pista" : "Una vez: suena y continúa");
  render();
  save();
}

function toggleStopAfter() {
  stopAfter = !stopAfter;
  toast(stopAfter ? "Se detendrá al terminar esta pista" : "Seguirá con la siguiente pista");
  renderPlayer();
}

// Fin de la pista (natural o por el punto de fin del recorte)
function trackEnded() {
  const t = tracks[current];
  if (!t) return;
  if (t.mode === "loop") {
    audio.currentTime = t.start ?? 0;
    fadeOutActive = false;
    if (audio.paused) playAudio(QUICK_FADE);
    return;
  }
  if (stopAfter) {
    stopAfter = false;
    stopPlayback();
    toast("Detenido al terminar la pista");
    return;
  }
  if (autoplay && current < tracks.length - 1) next(true);
  else stopPlayback();
}

audio.addEventListener("ended", trackEnded);

// Vigila el punto de fin y el fundido de salida mientras suena
setInterval(() => {
  const t = tracks[current];
  if (!t || audio.paused || pauseTimer || !isFinite(audio.duration)) return;
  const end = t.end != null ? Math.min(t.end, audio.duration) : audio.duration;
  const left = end - audio.currentTime;
  if (t.end != null && left <= 0.03) { trackEnded(); return; }
  if (!fadeGain) return;
  if (t.mode !== "loop" && fadeSec > 0 && left < fadeSec) {
    fadeOutActive = true;
    fadeGain.gain.setTargetAtTime(Math.max(0, left / fadeSec), audioCtx.currentTime, 0.03);
  } else if (fadeOutActive) {
    fadeOutActive = false; // se volvió atrás con la barra
    rampTo(1, QUICK_FADE);
  }
}, 40);

audio.addEventListener("error", () => {
  if (current < 0 || !audio.getAttribute("src")) return;
  tracks[current].error = true;
  toast("No se pudo reproducir esta pista");
  render();
  if (autoplay && current < tracks.length - 1) next(true);
});

audio.addEventListener("playing", () => {
  if (pendingFadeIn != null) { rampTo(1, pendingFadeIn); pendingFadeIn = null; }
});
["play", "pause"].forEach((e) => audio.addEventListener(e, () => { renderPlayer(); renderListState(); startSpectrum(); }));
audio.addEventListener("play", ensureAudioGraph);
audio.addEventListener("loadedmetadata", () => {
  if (pendingStart != null && pendingStart < audio.duration) audio.currentTime = pendingStart;
  pendingStart = null;
  if (current >= 0 && !tracks[current].duration) { tracks[current].duration = audio.duration; updateRow(tracks[current]); }
  renderTime();
});
audio.addEventListener("timeupdate", renderTime);

// ---------- Render ----------
function render() {
  els.empty.classList.toggle("show", tracks.length === 0);
  els.list.innerHTML = tracks.map((t, i) => rowHtml(t, i)).join("");
  if (drag?.active) markDragging();
  renderPlayer();
}

function durText(t) {
  if (t.error) return "error";
  if (t.duration == null) return "";
  if (!isTrimmed(t)) return fmt(t.duration);
  return fmt((t.end ?? t.duration) - (t.start ?? 0));
}

function rowHtml(t, i) {
  const active = i === current;
  const num = active
    ? `<span class="bars${isPlaying() ? "" : " paused"}"><i></i><i></i><i></i></span>`
    : i + 1;
  const loop = t.mode === "loop";
  const trimmed = isTrimmed(t);
  const artist = artistOf(t);
  return `
    <li class="row${active ? " active" : ""}${t.error ? " error" : ""}" data-i="${i}" data-id="${t.id}">
      <span class="num">${num}</span>
      <div class="title-cell">
        <div class="cover">${coverHtml(t)}</div>
        <div class="title-text">
          <div class="t-name" title="${escapeHtml(t.path)}">${escapeHtml(titleOf(t))}</div>
          ${artist ? `<div class="t-artist">${escapeHtml(artist)}</div>` : ""}
        </div>
      </div>
      <span class="meta${t.analyzed ? "" : " pending"}">${metaText(t)}</span>
      <span class="dur"${trimmed ? ` title="Duración con recorte (original ${fmt(t.duration)})"` : ""}>${durText(t)}</span>
      <button class="chip trim${trimmed ? " on" : ""}" data-act="trim" title="${trimmed ? "Recortada — editar inicio y fin" : "Recortar inicio y fin"}">${icon("trim")}</button>
      <button class="chip mode${loop ? " on" : ""}" data-act="mode" title="${loop ? "En bucle (clic: una vez)" : "Una vez (clic: en bucle)"}">${icon(loop ? "loop" : "once")}</button>
      <button class="chip rm" data-act="rm" title="Quitar de la lista">${icon("x")}</button>
    </li>`;
}

function updateRow(t) {
  const li = els.list.querySelector(`[data-id="${t.id}"]`);
  if (li) {
    li.outerHTML = rowHtml(t, tracks.indexOf(t));
    if (drag?.active && drag.id === t.id) markDragging();
  }
}

function renderListState() {
  const bars = els.list.querySelector(".bars");
  if (bars) bars.classList.toggle("paused", !isPlaying());
}

function renderPlayer() {
  const t = tracks[current];
  els.nowTitle.textContent = t ? titleOf(t) : "Nada sonando";
  const sub = t ? [artistOf(t), t.tags?.album].filter(Boolean).join(" · ") : "";
  els.nowSub.textContent = t ? (sub || (t.mode === "loop" ? "En bucle" : "Una vez")) : (tracks.length ? "Elige una pista" : "—");
  els.nowCover.innerHTML = t ? coverHtml(t) : icon("note");

  let meta = "";
  if (t && stopAfter) meta += `<span class="tag">Se detiene al terminar</span>`;
  if (t) {
    const bpm = bpmOf(t), key = keyOf(t);
    const bpmSrc = tagBpm(t) ? "Según la etiqueta del archivo" : "Detectado automáticamente";
    const keySrc = key?.fromTag ? "Según la etiqueta del archivo" : `Detectada automáticamente · confianza ${Math.round((key?.confidence || 0) * 100)}%`;
    if (bpm && (tagBpm(t) || t.analyzed)) meta += `<span class="tag" title="${bpmSrc}">${Math.round(bpm)} BPM</span>`;
    if (key && (key.fromTag || t.analyzed)) meta += `<span class="tag" title="${keySrc}">${keyLong(key)} · ${camelot(key)}</span>`;
    if (!t.analyzed && analyzing === t && !(tagBpm(t) && tagKey(t))) meta += `<span class="tag dim">Analizando…</span>`;
  }
  els.nowMeta.innerHTML = meta;

  const playing = isPlaying();
  els.play.innerHTML = icon(playing ? "pause" : "play");
  els.play.title = playing ? "Pausar (Espacio)" : "Reproducir (Espacio)";

  const loop = t && t.mode === "loop";
  els.mode.innerHTML = icon(loop ? "loop" : "once");
  els.mode.classList.toggle("on", !!loop);
  els.mode.disabled = !t;
  els.mode.title = loop ? "Pista en bucle — clic para reproducir una vez" : "Pista una vez — clic para ponerla en bucle";

  els.autoplay.classList.toggle("on", autoplay);
  els.autoplay.title = autoplay ? "Reproducción automática: activada (A)" : "Reproducción automática: desactivada (A)";
  els.stopAfter.classList.toggle("on", stopAfter);
  els.stopAfter.disabled = !t;
  els.stopAfter.title = stopAfter ? "Se detendrá al terminar esta pista (S)" : "Detener después de esta pista (S)";

  els.prev.disabled = els.next.disabled = !tracks.length;
  els.mute.innerHTML = icon(muted || volume === 0 ? "mute" : "vol");
  els.seek.disabled = !t;

  if ("mediaSession" in navigator && t) {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: titleOf(t), artist: artistOf(t) || "Onda", album: t.tags?.album || "",
      artwork: t.cover ? [{ src: t.cover }] : [],
    });
    navigator.mediaSession.playbackState = playing ? "playing" : "paused";
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
  // Zonas recortadas en la barra de progreso
  const t = tracks[current];
  const ok = t && isFinite(d) && d > 0;
  const s = ok && t.start != null ? (t.start / d) * 100 : 0;
  const e = ok && t.end != null ? (Math.min(t.end, d) / d) * 100 : 100;
  els.trimL.classList.toggle("show", s > 0);
  els.trimR.classList.toggle("show", e < 100);
  els.trimL.style.left = "0%";
  els.trimL.style.width = `${s}%`;
  els.trimR.style.left = `${e}%`;
  els.trimR.style.width = `${100 - e}%`;
}

// ---------- Reordenar arrastrando ----------
let drag = null;          // { id, startY, active, pointerId }
let suppressClick = false;

function moveTrack(from, to) {
  const [t] = tracks.splice(from, 1);
  tracks.splice(to, 0, t);
  if (current === from) current = to;
  else if (from < current && to >= current) current--;
  else if (from > current && to <= current) current++;
}

function markDragging() {
  els.list.querySelector(`[data-id="${drag.id}"]`)?.classList.add("dragging");
}

els.list.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || e.target.closest("[data-act]")) return;
  const li = e.target.closest(".row");
  if (li) drag = { id: +li.dataset.id, startY: e.clientY, active: false, pointerId: e.pointerId };
});

window.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (!drag.active) {
    if (Math.abs(e.clientY - drag.startY) < 6) return;
    drag.active = true;
    els.list.classList.add("reordering");
    markDragging();
  }
  e.preventDefault();
  // desplazar la lista si se arrastra cerca de los bordes
  const wrap = els.list.parentElement, r = wrap.getBoundingClientRect();
  if (e.clientY < r.top + 36) wrap.scrollTop -= 10;
  else if (e.clientY > r.bottom - 36) wrap.scrollTop += 10;
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest(".row");
  if (!over) return;
  const from = tracks.findIndex((t) => t.id === drag.id);
  const to = +over.dataset.i;
  if (from >= 0 && from !== to) { moveTrack(from, to); render(); }
});

function endDrag() {
  if (!drag) return;
  if (drag.active) {
    suppressClick = true;
    setTimeout(() => (suppressClick = false), 0);
    els.list.classList.remove("reordering");
    drag = null;
    render();
    save();
  }
  drag = null;
}
window.addEventListener("pointerup", endDrag);
window.addEventListener("pointercancel", endDrag);

// ---------- Recortar inicio y fin ----------
let trimTrack = null;

function parseTime(s) {
  s = s.trim().replace(",", ".");
  if (!s) return null;
  const parts = s.split(":").map(Number);
  if (parts.length > 3 || parts.some((v) => !isFinite(v) || v < 0)) return NaN;
  return parts.reduce((acc, v) => acc * 60 + v, 0);
}
const fmtPrecise = (s) => {
  const m = Math.floor(s / 60), sec = s - m * 60;
  return `${m}:${sec.toFixed(1).padStart(4, "0")}`;
};

function openTrim(i) {
  trimTrack = tracks[i];
  if (!trimTrack) return;
  els.trimTitle.textContent = titleOf(trimTrack);
  els.trimCover.innerHTML = coverHtml(trimTrack);
  els.trimStart.value = trimTrack.start != null ? fmtPrecise(trimTrack.start) : "";
  els.trimEnd.value = trimTrack.end != null ? fmtPrecise(trimTrack.end) : "";
  els.trimStart.classList.remove("invalid");
  els.trimEnd.classList.remove("invalid");
  els.trimDialog.hidden = false;
  updateTrimUI();
  els.trimStart.focus();
}

function closeTrim() {
  els.trimDialog.hidden = true;
  trimTrack = null;
}

function updateTrimUI() {
  const t = trimTrack;
  if (!t) return;
  const isCur = t === tracks[current];
  els.trimStartNow.disabled = els.trimEndNow.disabled = !isCur;
  let info = "";
  if (t.duration != null) {
    info = `Duración ${fmt(t.duration)}`;
    if (isTrimmed(t)) info += ` · con recorte ${durText(t)}`;
  }
  if (!isCur) info += (info ? " · " : "") + "«Usar posición actual» funciona con la pista que está sonando";
  els.trimInfo.textContent = info;
}

function setTrim(t, s, e) {
  t.start = s != null && s > 0.05 ? s : null;
  t.end = e != null && !(t.duration && e >= t.duration - 0.05) ? e : null;
  if (t === tracks[current]) {
    audio.loop = t.mode === "loop" && !isTrimmed(t);
    if (t.start != null && audio.currentTime < t.start) audio.currentTime = t.start;
  }
  updateRow(t);
  renderTime();
  updateTrimUI();
  save();
}

function applyTrimInputs() {
  const t = trimTrack;
  if (!t) return true;
  const dur = t.duration ?? Infinity;
  const s = parseTime(els.trimStart.value), e = parseTime(els.trimEnd.value);
  const badS = Number.isNaN(s) || (s != null && s >= dur);
  const badE = Number.isNaN(e) || (e != null && (e <= 0 || e > dur + 0.5)) ||
    (!badS && s != null && e != null && e <= s + 0.5);
  els.trimStart.classList.toggle("invalid", badS);
  els.trimEnd.classList.toggle("invalid", badE);
  if (badS || badE) {
    els.trimInfo.textContent = "Revisa los tiempos: usa minutos:segundos, por ejemplo 0:12.5, y el fin debe ir después del inicio.";
    return false;
  }
  setTrim(t, s, e);
  return true;
}

[els.trimStart, els.trimEnd].forEach((input) => {
  input.addEventListener("change", applyTrimInputs);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && applyTrimInputs()) closeTrim(); });
});
els.trimStartNow.addEventListener("click", () => {
  const t = trimTrack;
  setTrim(t, audio.currentTime, t.end != null && t.end > audio.currentTime + 0.5 ? t.end : null);
  els.trimStart.value = t.start != null ? fmtPrecise(t.start) : "";
  els.trimEnd.value = t.end != null ? fmtPrecise(t.end) : "";
});
els.trimEndNow.addEventListener("click", () => {
  const t = trimTrack;
  setTrim(t, t.start != null && t.start < audio.currentTime - 0.5 ? t.start : null, audio.currentTime);
  els.trimStart.value = t.start != null ? fmtPrecise(t.start) : "";
  els.trimEnd.value = t.end != null ? fmtPrecise(t.end) : "";
});
els.trimReset.addEventListener("click", () => {
  setTrim(trimTrack, null, null);
  els.trimStart.value = els.trimEnd.value = "";
  els.trimStart.classList.remove("invalid");
  els.trimEnd.classList.remove("invalid");
});
// Escuchar los últimos 5 segundos para comprobar cómo termina
els.trimPreview.addEventListener("click", () => {
  if (!applyTrimInputs()) return;
  const t = trimTrack, i = tracks.indexOf(t);
  const go = () => {
    const end = t.end ?? audio.duration;
    audio.currentTime = Math.max(end - 5, t.start ?? 0);
    playAudio(QUICK_FADE);
  };
  if (t === tracks[current] && isFinite(audio.duration)) go();
  else {
    select(i, false);
    audio.addEventListener("loadedmetadata", () => setTimeout(go, 0), { once: true });
  }
  updateTrimUI();
});
els.trimDone.addEventListener("click", () => { if (applyTrimInputs()) closeTrim(); });
els.trimDialog.addEventListener("pointerdown", (e) => { if (e.target === els.trimDialog) closeTrim(); });

function markHere(which) {
  const t = tracks[current];
  if (!t || !isFinite(audio.duration)) return;
  const now = audio.currentTime;
  if (which === "start") {
    setTrim(t, now, t.end != null && t.end > now + 0.5 ? t.end : null);
    toast(`Inicio marcado en ${fmtPrecise(now)}`);
  } else {
    setTrim(t, t.start != null && t.start < now - 0.5 ? t.start : null, now);
    toast(`Fin marcado en ${fmtPrecise(now)}`);
  }
}

// ---------- Ajustes ----------
function renderFadeOpts() {
  els.fadeOpts.querySelectorAll("button").forEach((b) => b.classList.toggle("on", +b.dataset.fade === fadeSec));
}
els.settings.addEventListener("click", (e) => {
  e.stopPropagation();
  els.settingsMenu.hidden = !els.settingsMenu.hidden;
  renderFadeOpts();
});
document.addEventListener("click", (e) => {
  if (!els.settingsMenu.hidden && !e.target.closest(".menu-wrap")) els.settingsMenu.hidden = true;
});
els.fadeOpts.addEventListener("click", (e) => {
  const b = e.target.closest("[data-fade]");
  if (!b) return;
  fadeSec = +b.dataset.fade;
  renderFadeOpts();
  toast(fadeSec ? `Fundido de ${fadeSec} s` : "Sin fundido");
  save();
});

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
els.stopAfter.addEventListener("click", toggleStopAfter);
els.autoplay.addEventListener("click", () => {
  autoplay = !autoplay;
  toast(autoplay ? "Reproducción automática activada" : "Reproducción automática desactivada");
  renderPlayer();
  save();
});

els.list.addEventListener("click", (e) => {
  if (suppressClick) return;
  const li = e.target.closest(".row");
  if (!li) return;
  const i = +li.dataset.i;
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "mode") setMode(i);
  else if (act === "rm") removeTrack(i);
  else if (act === "trim") openTrim(i);
});
els.list.addEventListener("dblclick", (e) => {
  if (suppressClick || e.target.closest("[data-act]")) return;
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
  if (!els.trimDialog.hidden) {
    if (e.key === "Escape") closeTrim();
    return;
  }
  if (e.key === "Escape") { els.settingsMenu.hidden = true; return; }
  if (e.target.tagName === "INPUT" && e.target.type !== "range") return;
  if (e.ctrlKey && e.key === "ArrowRight") { next(); return; }
  if (e.ctrlKey && e.key === "ArrowLeft") { prev(); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (e.key === " ") { e.preventDefault(); togglePlay(); }
  else if (e.key === "ArrowRight" && current >= 0) audio.currentTime = Math.min(audio.currentTime + 5, audio.duration || 0);
  else if (e.key === "ArrowLeft" && current >= 0) audio.currentTime = Math.max(audio.currentTime - 5, 0);
  else if (k === "l" && current >= 0) setMode(current);
  else if (k === "a") els.autoplay.click();
  else if (k === "s" && current >= 0) toggleStopAfter();
  else if (k === "v") setVizMode(vizMode === "bars" ? "wave" : "bars");
  else if (k === "i") markHere("start");
  else if (k === "o") markHere("end");
  else if (k === "r" && current >= 0) openTrim(current);
});

// Teclas multimedia del teclado / controles del sistema
if ("mediaSession" in navigator) {
  const ms = navigator.mediaSession;
  ms.setActionHandler("play", () => playAudio(resumeFade()));
  ms.setActionHandler("pause", pauseAudio);
  ms.setActionHandler("nexttrack", () => next());
  ms.setActionHandler("previoustrack", prev);
}

// ---------- Inicio ----------
load();
applyVolume();
render();
renderFadeOpts();
probeDurations();
readTagsQueue();
analyzeQueue();
startSpectrum();
