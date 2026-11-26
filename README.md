# Onda

Reproductor de MP3 de escritorio, minimalista, hecho con [Tauri 2](https://tauri.app).

## Funciones

- Lista de reproducción: agregar con el botón o arrastrando archivos desde el Explorador.
- Modo por pista: **una vez** (suena y sigue) o **en bucle** (se repite).
- Reproducción automática de la lista.
- Visualización en tiempo real: **espectro** de barras u **ondas** (osciloscopio).
- Análisis automático de **BPM** y **tonalidad** (notación latina y Camelot).
- Tema claro u oscuro según Windows; la lista y las preferencias se guardan al cerrar.

## Atajos de teclado

| Tecla | Acción |
| --- | --- |
| `Espacio` | Reproducir / pausar |
| `←` / `→` | Retroceder / avanzar 5 s |
| `Ctrl` + `←` / `→` | Pista anterior / siguiente |
| `L` | Bucle de la pista actual |
| `A` | Reproducción automática |
| `V` | Cambiar entre espectro y ondas |

También responde a las teclas multimedia del teclado.

## Desarrollo

Requisitos: [Node.js](https://nodejs.org), [Rust](https://rustup.rs) y las herramientas de compilación de C++ de Visual Studio.

```bash
npm install
npm run dev     # abre la app en modo desarrollo
npm run build   # genera el instalador en src-tauri/target/release/bundle/
```

La interfaz está en `src/` (HTML, CSS y JavaScript sin dependencias) y el análisis de audio corre en un Web Worker (`src/analyzer.js`).
