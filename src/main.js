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
  nowTitle: $("now-title"), nowSub: $("now-sub"), drop: $("drop"), toast: $("toast"),
};

const audio = new Audio();
audio.preload = "auto";

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
      tracks: tracks.map(({ path, mode, duration }) => ({ path, mode, duration })),
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
    tracks = (s.tracks || []).map((t) => makeTrack(t.path, null, t.mode, t.duration));
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

// ---------- Reproducción ----------
function select(i, play = true) {
  if (i < 0 || i >= tracks.length) return;
  current = i;
  const t = tracks[i];
  audio.src = t.url;
  audio.loop = t.mode === "loop";
  if (play) audio.play().catch(() => {});
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

["play", "pause"].forEach((e) => audio.addEventListener(e, () => { renderPlayer(); renderListState(); }));
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
  audio.volume = volume;
  audio.muted = muted;
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
