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

function detectKey(x, sr) {
  const N = 8192, hop = 4096;
  const fft = makeFFT(N);
  const frames = Math.floor((x.length - N) / hop);
  if (frames < 4) return null;
  // Mapa bin → clase de altura (55 Hz a 2 kHz)
  const binPc = new Int8Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = (k * sr) / N;
    if (f < 55 || f > 2000) continue;
    const midi = 69 + 12 * Math.log2(f / 440);
    if (Math.abs(midi - Math.round(midi)) > 0.35) continue; // descartar bins entre notas
    binPc[k] = ((Math.round(midi) % 12) + 12) % 12;
  }
  const chroma = new Float64Array(12);
  const frameChroma = new Float64Array(12);
  for (let f = 0; f < frames; f++) {
    const mag = fft(x, f * hop);
    frameChroma.fill(0);
    let total = 0;
    for (let k = 1; k < N / 2; k++) {
      const pc = binPc[k];
      if (pc < 0) continue;
      const v = mag[k] * mag[k];
      frameChroma[pc] += v;
      total += v;
    }
    if (total <= 1e-9) continue;
    for (let p = 0; p < 12; p++) chroma[p] += Math.sqrt(frameChroma[p] / total);
  }
  let best = -Infinity, key = null;
  for (let tonic = 0; tonic < 12; tonic++) {
    const rot = Array.from({ length: 12 }, (_, i) => chroma[(i + tonic) % 12]);
    const maj = pearson(rot, MAJOR), min = pearson(rot, MINOR);
    if (maj > best) { best = maj; key = { tonic, minor: false }; }
    if (min > best) { best = min; key = { tonic, minor: true }; }
  }
  if (key) key.confidence = Math.round(best * 100) / 100;
  return key;
}

self.onmessage = (e) => {
  const { id, samples, sampleRate } = e.data;
  try {
    const bpm = detectBPM(samples, sampleRate);
    const key = detectKey(samples, sampleRate);
    self.postMessage({ id, bpm, key });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
