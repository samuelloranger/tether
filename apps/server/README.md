# Tether 📱🔌

> Persistent terminal agent console designed for mobile browsers and background stability.

**Tether** is a self-hosted, lightweight web application built to run long-running terminal agents (like `claude-code`, `antigravity`, or standard interactive bash shells) persistently on your server. It is specifically designed to solve the issue of iOS backgrounding aggressively killing TCP/SSH connections (causing WebSSH and other client apps to drop sessions and interrupt running agents).

---

## 🛠️ The Architecture

Instead of connecting directly via SSH, you run **Tether** on your host. You access the terminal console using an installable **Progressive Web App (PWA)** built on Svelte 5.

*   **Native Bun PTY:** Spawns subprocesses natively using Bun's fast built-in terminal spawn wrapper (`Bun.spawn`), avoiding heavy legacy compiled C++ add-ons like `node-pty`.
*   **Persistent SQLite Log Cache:** All terminal stdout chunks are buffered directly into an SQLite database with incremental row IDs.
*   **State-Recovery Protocol:** If the iOS device goes to sleep, locks, or suspends the browser tab, the connection drops. Upon focus/wakeup, the Svelte client automatically reconnects, sends the last received log ID, and re-syncs all missed terminal output logs instantly from the SQLite cache. Your background processes are never interrupted.
*   **Mobile-First Virtual Terminal:** Avoids hard-to-use virtual keyboard terminal inputs by providing a hybrid chat-style prompt input, along with persistent controls for key combinations (`Ctrl+C`, `Tab`, `Ctrl+D`, `Esc`) and command history navigation.

---

## 🚀 Tech Stack
*   **Runtime:** [Bun](https://bun.sh)
*   **Backend Web Server:** [Hono](https://hono.dev) + WebSockets
*   **Database:** Bun Native SQLite (`bun:sqlite`)
*   **Frontend UI:** [Svelte 5](https://svelte.dev) + TypeScript + Vite
*   **Icons:** [Lucide Svelte](https://github.com/lucide-dev/lucide)
*   **Formatting/Linter:** [Biome](https://biomejs.dev)

---

## 💻 Development

### Setup
Ensure you have Bun installed, then install dependencies:
```bash
bun install
```

### Run in Dev Mode
Run the Hono API server in watch mode (port `8085`):
```bash
bun run dev
```

In a separate terminal, launch the Svelte development server (port `5173`):
```bash
cd src/web && bun run dev
```
*Note: Vite dev server is pre-configured to proxy `/api` and WebSocket upgrade requests to the Hono backend on port `8085`.*

---

## 📦 Production Deployment

To compile the Svelte 5 frontend and package the Hono backend into a single distribution:
```bash
bun run build
```
This builds the client assets to `src/web/dist` and bundles the server into `dist/index.js`.

To start the production server:
```bash
bun run start
```
The application will run on port `8085` (or `process.env.TETHER_PORT`). You can access it in your browser and save it to your iOS Home Screen as a standalone PWA.
