# Onda

Reproductor de MP3 de escritorio, minimalista, hecho con [Tauri 2](https://tauri.app).

## Funciones

- Lista de reproducción: agregar con el botón o arrastrando archivos desde el Explorador; reordenar arrastrando.
- Carátula, título, artista y álbum desde las etiquetas del MP3.
- Modo por pista: **una vez** (suena y sigue) o **en bucle** (se repite).
- **Recorte** de inicio y fin por pista, **fundidos** y **detener después de esta pista**.
- Reproducción automática de la lista.
- Visualización en tiempo real: **espectro** de barras u **ondas** (osciloscopio).
- Análisis automático de **BPM** y **tonalidad** (notación latina y Camelot).
- Tema claro u oscuro según Windows; la lista y las preferencias se guardan al cerrar.

## Instalación

Descarga el instalador desde la [última versión](https://github.com/LuisSubiabre/onda/releases/latest):

- **Windows 10/11:** `Onda_x.y.z_x64-setup.exe`. Si SmartScreen avisa, elige *Más información → Ejecutar de todas formas*.
- **macOS (chip Apple o Intel):** `Onda_x.y.z_universal.dmg`. Arrastra Onda a Aplicaciones. Como la app no está firmada, la primera vez ábrela con clic derecho → *Abrir* → *Abrir*.

## Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `Espacio` | Reproducir / pausar |
| `←` / `→` | Retroceder / avanzar 5 s |
| `Ctrl` + `←` / `→` | Pista anterior / siguiente |
| `L` | Bucle de la pista actual |
| `A` | Reproducción automática |
| `V` | Cambiar entre espectro y ondas |
| `S` | Detener después de la pista actual |
| `I` / `O` | Marcar inicio / fin de la pista en la posición actual |
| `R` | Abrir el editor de recorte de la pista actual |

También responde a las teclas multimedia del teclado.

## Desarrollo

Requisitos: [Node.js](https://nodejs.org), [Rust](https://rustup.rs) y las herramientas de compilación de C++ de Visual Studio.

```bash
npm install
npm run dev     # abre la app en modo desarrollo
npm run build   # genera el instalador en src-tauri/target/release/bundle/
```

Al subir una etiqueta de versión (`git tag v0.3.0 && git push --tags`), GitHub Actions compila los instaladores de Windows y macOS y los adjunta al release.

La interfaz está en `src/` (HTML, CSS y JavaScript sin dependencias) y el análisis de audio corre en un Web Worker (`src/analyzer.js`).
