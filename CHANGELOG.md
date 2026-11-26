# Cambios

## 0.3.0

- Reordenar la lista arrastrando las pistas.
- Carátula, título, artista y álbum leídos de las etiquetas ID3 del MP3 (con el compositor como respaldo del artista).
- BPM y tonalidad tomados de las etiquetas del archivo cuando existen (TBPM, TKEY); si no, se detectan.
- Fundido al pausar, reanudar y entre pistas (No / 1 / 2 / 3 / 5 s), en el menú de ajustes.
- Un solo botón decide qué pasa al terminar una pista: seguir con la lista, detenerse solo esta vez (tecla `S`) o detenerse después de cada pista. Reemplaza al botón de reproducción automática.
- Punto de inicio y fin por pista (recorte), con editor, teclas `I` / `O` y zonas marcadas en la barra de progreso.

## 0.2.0

- Espectro de 64 bandas en tiempo real, independiente del volumen.
- Visualización de ondas (osciloscopio) seleccionable junto al espectro (tecla `V`).
- Análisis de BPM y tonalidad de cada pista, con código Camelot.
- Detección de tonalidad sobre la canción completa, separando notas de sus armónicos y corrigiendo la afinación.

## 0.1.0

- Primera versión: lista de reproducción, modo una vez / en bucle por pista, reproducción automática, arrastrar y soltar, atajos de teclado y teclas multimedia.
