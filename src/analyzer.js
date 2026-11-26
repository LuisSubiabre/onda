// Onda — análisis de BPM y tonalidad (Web Worker)
// Recibe { id, samples: Float32Array (mono), sampleRate } y responde { id, bpm, key }.

// ---------- FFT radix-2 in-place ----------
function makeFFT(n) {
  const levels = Math.log2(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos((2 * Math.PI * i) / n); sin[i] = Math.sin((2 * Math.PI * i) / n); }
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)); // Hann
  const re = new Float64Array(n), im = new Float64Array(n);
  const mag = new Float64Array(n / 2);

  // Devuelve la magnitud del espectro del bloque x[off .. off+n)
  return function (x, off) {
    for (let i = 0; i < n; i++) { re[rev[i]] = (x[off + i] || 0) * win[i]; im[rev[i]] = 0; }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] + im[b] * sin[k];
          const ti = im[b] * cos[k] - re[b] * sin[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
    for (let i = 0; i < n / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
    return mag;
  };
}

// ---------- BPM: flujo espectral + autocorrelación ----------
function detectBPM(x, sr) {
  const N = 1024, hop = 128;
  const fft = makeFFT(N);
  const frames = Math.floor((x.length - N) / hop);
  if (frames < 200) return null;
  const envRate = sr / hop;
  const maxBin = Math.floor((8000 / sr) * N);
  const flux = new Float64Array(frames);
  let prev = new Float64Array(N / 2);
  for (let f = 0; f < frames; f++) {
    const mag = fft(x, f * hop);
    let s = 0;
    for (let k = 1; k < Math.min(maxBin, N / 2); k++) {
      const v = Math.log1p(100 * mag[k]);
      const d = v - prev[k];
      if (d > 0) s += d;
      prev[k] = v;
    }
    flux[f] = s;
  }
  // Quitar la tendencia (media móvil) y rectificar
  const W = Math.round(envRate * 0.5);
  const onset = new Float64Array(frames);
  let acc = 0;
  for (let i = 0; i < frames; i++) {
    acc += flux[i];
    if (i >= W) acc -= flux[i - W];
    const mean = acc / Math.min(i + 1, W);
    onset[i] = Math.max(0, flux[i] - mean);
  }
  // Autocorrelación en el rango 50–220 BPM
  const minLag = Math.floor((60 * envRate) / 220);
  const maxLag = Math.ceil((60 * envRate) / 50);
  const ac = new Float64Array(maxLag * 2 + 2);
  for (let lag = minLag; lag < ac.length && lag < frames; lag++) {
    let s = 0;
    for (let i = 0; i + lag < frames; i++) s += onset[i] * onset[i + lag];
    ac[lag] = s / (frames - lag);
  }
  // Puntuar cada tempo sumando sus múltiplos y favorecer el rango 80–160
  let best = -1, bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * envRate) / lag;
    let score = ac[lag] + 0.5 * (ac[lag * 2] || 0);
    const w = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2));
    score *= w;
    if (score > best) { best = score; bestLag = lag; }
  }
  if (!bestLag) return null;
  // Interpolación parabólica para afinar
  const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
  const denom = a - 2 * b + c;
  const shift = denom ? (0.5 * (a - c)) / denom : 0;
  let bpm = (60 * envRate) / (bestLag + Math.max(-0.5, Math.min(0.5, shift)));
  while (bpm < 70) bpm *= 2;
  while (bpm > 180) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

// ---------- Tonalidad: cromagrama + perfiles de Krumhansl ----------
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return num / Math.sqrt(da * db || 1);
}

// Rango de notas analizadas (MIDI 28 = Mi1 … 96 = Do7)
const LO = 28, HI = 96, NB = HI - LO + 1;

// Diccionario de notas: cada nota con sus armónicos (amplitud 0.8^(h-1))
const NOTE_DICT = (() => {
  const W = Array.from({ length: NB }, () => new Float64Array(NB));
  for (let n = 0; n < NB; n++) {
    for (let h = 1; h <= 8; h++) {
      const m = n + Math.round(12 * Math.log2(h));
      if (m >= NB) break;
      W[n][m] += Math.pow(0.8, h - 1);
    }
  }
  return W;
})();

// Separa el espectro en notas fundamentales (mínimos cuadrados no negativos),
// así los armónicos de una nota no se cuentan como otras notas
function nnlsNotes(v, iters = 40) {
  const W = NOTE_DICT;
  const x = new Float64Array(NB).fill(1e-3);
  const Wv = new Float64Array(NB), Wx = new Float64Array(NB);
  for (let n = 0; n < NB; n++) { let s = 0; for (let m = 0; m < NB; m++) s += W[n][m] * v[m]; Wv[n] = s; }
  for (let it = 0; it < iters; it++) {
    Wx.fill(0);
    for (let n = 0; n < NB; n++) if (x[n] > 1e-12) for (let m = 0; m < NB; m++) Wx[m] += W[n][m] * x[n];
    for (let n = 0; n < NB; n++) {
      let s = 0;
      for (let m = 0; m < NB; m++) s += W[n][m] * Wx[m];
      x[n] *= Wv[n] / (s + 1e-12);
    }
  }
  return x;
}

// Estima cuántos cents está desafinada la grabación respecto de La 440
function estimateTuning(x, sr, fft, N, hop) {
  const hist = new Float64Array(100);
  const step = hop * 4;
  for (let off = 0; off + N <= x.length; off += step) {
    const mag = fft(x, off);
    for (let k = 2; k < N / 2 - 1; k++) {
      const f0 = (k * sr) / N;
      if (f0 < 150 || f0 > 2000) continue;
      if (!(mag[k] > mag[k - 1] && mag[k] >= mag[k + 1])) continue;
      const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(mag[k] + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
      const d = (0.5 * (a - c)) / (a - 2 * b + c || 1);
      const m = 69 + 12 * Math.log2((((k + d) * sr) / N) / 440);
      hist[Math.min(99, Math.max(0, Math.floor((m - Math.round(m)) * 100 + 50)))] += mag[k];
    }
  }
  let bi = 0;
  for (let i = 0; i < 100; i++) if (hist[i] > hist[bi]) bi = i;
  return bi - 50 + 0.5;
}

function detectKey(x, sr) {
  const N = 8192, hop = 4096;
  const fft = makeFFT(N);
  const frames = Math.floor((x.length - N) / hop);
  if (frames < 4) return null;
  const tuning = estimateTuning(x, sr, fft, N, hop);

  // Pesos de cada bin hacia su semitono (corrigiendo la afinación)
  const binNote = new Int16Array(N / 2).fill(-1);
  const binW = new Float64Array(N / 2);
  for (let k = 1; k < N / 2; k++) {
    const m = 69 + 12 * Math.log2(((k * sr) / N) / 440) - tuning / 100;
    const r = Math.round(m);
    if (r < LO || r > HI) continue;
    binNote[k] = r - LO;
    binW[k] = Math.max(0, 1 - Math.abs(m - r) * 2.5);
  }

  // Se analiza la canción completa: las piezas suelen modular en la mitad
  const treble = new Float64Array(12), bass = new Float64Array(12);
  const spec = new Float64Array(NB);
  for (let f = 0; f < frames; f += 2) {
    const mag = fft(x, f * hop);
    spec.fill(0);
    for (let k = 1; k < N / 2; k++) if (binNote[k] >= 0) spec[binNote[k]] += mag[k] * mag[k] * binW[k];
    let energy = 0;
    for (let i = 0; i < NB; i++) { spec[i] = Math.sqrt(spec[i]); energy += spec[i]; }
    if (energy < 1e-6) continue;
    const notes = nnlsNotes(spec);
    const tc = new Float64Array(12), bc = new Float64Array(12);
    let tt = 0, bt = 0;
    for (let i = 0; i < NB; i++) {
      const m = i + LO, a = notes[i];
      if (m >= 36 && m <= 84) { tc[m % 12] += a; tt += a; }
      if (m <= 52) { bc[m % 12] += a; bt += a; }
    }
    if (tt > 0) for (let p = 0; p < 12; p++) treble[p] += tc[p] / tt;
    if (bt > 0) for (let p = 0; p < 12; p++) bass[p] += bc[p] / bt;
  }
  // El bajo suele marcar la tónica: se suma con medio peso
  const chroma = treble.map((v, i) => v + 0.5 * bass[i]);

  let best = -Infinity, key = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12]);
    const maj = pearson(rot, MAJOR), min = pearson(rot, MINOR);
    if (maj > best) { best = maj; key = { tonic, minor: false }; }
    if (min > best) { best = min; key = { tonic, minor: true }; }
  }
  if (key) {
    key.confidence = Math.round(best * 100) / 100;
    key.tuning = Math.round(tuning);
  }
  return key;
}

self.onmessage = (e) => {
  const { id, samples, sampleRate } = e.data;
  try {
    // Para el ritmo basta un minuto del centro de la canción
    const seg = Math.min(samples.length, 60 * sampleRate);
    const start = Math.floor((samples.length - seg) * 0.4);
    const bpm = detectBPM(samples.subarray(start, start + seg), sampleRate);
    const key = detectKey(samples, sampleRate);
    self.postMessage({ id, bpm, key });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
