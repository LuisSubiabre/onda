// Onda — lector mínimo de etiquetas ID3v2 (2.2, 2.3 y 2.4)
// Devuelve { title, artist, album, cover: Blob | null } o null si el archivo no tiene etiquetas.

async function fetchRange(url, start, end) {
  const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
  const buf = new Uint8Array(await res.arrayBuffer());
  // Si el servidor ignoró el rango, llega el archivo completo
  return res.status === 206 ? buf : buf.subarray(start, end + 1);
}

const synchsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const be24 = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];

// Quita los bytes de "desincronización" (0xFF 0x00 → 0xFF)
function unsync(b) {
  const out = new Uint8Array(b.length);
  let j = 0;
  for (let i = 0; i < b.length; i++) {
    out[j++] = b[i];
    if (b[i] === 0xff && b[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decodeText(enc, bytes) {
  let label = "latin1";
  if (enc === 1) label = "utf-16";
  else if (enc === 2) label = "utf-16be";
  else if (enc === 3) label = "utf-8";
  try {
    return new TextDecoder(label).decode(bytes).replace(/\u0000+$/g, "").split("\u0000")[0].trim();
  } catch {
    return "";
  }
}

// Busca el final de una cadena terminada en 0 (o 00 00 en UTF-16)
function findTerminator(b, from, enc) {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
  } else {
    for (let i = from; i < b.length; i++) if (b[i] === 0) return i;
  }
  return b.length;
}

function parsePicture(b, v2) {
  const enc = b[0];
  let i = 1, mime;
  if (v2) {
    const fmt = String.fromCharCode(b[1], b[2], b[3]).toLowerCase();
    mime = fmt === "png" ? "image/png" : "image/jpeg";
    i = 4;
  } else {
    const end = findTerminator(b, 1, 0);
    mime = new TextDecoder("latin1").decode(b.subarray(1, end)) || "image/jpeg";
    if (!mime.includes("/")) mime = `image/${mime.toLowerCase() === "png" ? "png" : "jpeg"}`;
    i = end + 1;
  }
  const type = b[i++];
  const dEnd = findTerminator(b, i, enc);
  i = dEnd + (enc === 1 || enc === 2 ? 2 : 1);
  return { type, blob: new Blob([b.slice(i)], { type: mime }) };
}

export async function readID3(url) {
  const head = await fetchRange(url, 0, 9);
  if (head.length < 10 || head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return null; // "ID3"
  const ver = head[3], flags = head[5];
  const size = synchsafe(head, 6);
  if (ver < 2 || ver > 4 || size <= 0) return null;

  let tag = await fetchRange(url, 10, 10 + size - 1);
  if (flags & 0x80 && ver < 4) tag = unsync(tag);

  let pos = 0;
  if (flags & 0x40 && ver >= 3) pos += ver === 4 ? synchsafe(tag, 0) : be32(tag, 0) + 4; // cabecera extendida

  const out = { title: "", artist: "", album: "", albumArtist: "", composer: "", bpm: "", key: "", cover: null };
  const TEXT = {
    TIT2: "title", TT2: "title", TPE1: "artist", TP1: "artist", TALB: "album", TAL: "album",
    TPE2: "albumArtist", TP2: "albumArtist", TCOM: "composer", TCM: "composer",
    TBPM: "bpm", TBP: "bpm", TKEY: "key", TKE: "key",
  };
  const v2 = ver === 2;
  const idLen = v2 ? 3 : 4, hdrLen = v2 ? 6 : 10;
  let coverType = -1;

  while (pos + hdrLen <= tag.length) {
    const id = String.fromCharCode(...tag.subarray(pos, pos + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // relleno
    const fsize = v2 ? be24(tag, pos + 3) : ver === 4 ? synchsafe(tag, pos + 4) : be32(tag, pos + 4);
    const fflags = v2 ? 0 : tag[pos + 9];
    pos += hdrLen;
    if (fsize <= 0 || pos + fsize > tag.length) break;
    let body = tag.subarray(pos, pos + fsize);
    pos += fsize;
    if (ver === 4 && fflags & 0x02) body = unsync(body);
    if (ver === 4 && fflags & 0x01) body = body.subarray(4); // longitud de datos

    if (TEXT[id]) out[TEXT[id]] = decodeText(body[0], body.subarray(1));
    else if (id === "APIC" || id === "PIC") {
      try {
        const pic = parsePicture(body, v2);
        // preferir la portada frontal (tipo 3)
        if (coverType !== 3 && (pic.type === 3 || !out.cover)) { out.cover = pic.blob; coverType = pic.type; }
      } catch {}
    }
  }
  return out;
}
