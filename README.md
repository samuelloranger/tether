# Tether Monorepo 📱🔌

> Persistent terminal agent console containing the Hono backend server and Expo React Native mobile client.

This repository is organized as a monorepo utilizing Bun workspaces.

---

## 📂 Repository Structure

*   `apps/server/`: Bun + Hono backend server (Pty launcher & SQLite logger) and Svelte 5 web client.
*   `apps/mobile/`: Expo React Native mobile client with AsyncStorage configuration persistence and custom ANSI-to-native Text parser.

---

## 🚀 Quick Start

### 1. Install all dependencies
From the root of the repository, run:
```bash
bun install
```
*Bun workspaces will automatically resolve, link, and hoist package dependencies across all workspaces.*

### 2. Launch Development
*   **Start the Hono backend:**
    ```bash
    bun dev:server
    ```
    This launches the backend server on port `8085` (exposed locally to `0.0.0.0`).
*   **Start the Svelte Web client (Vite dev server):**
    ```bash
    bun dev:web
    ```
    Exposed on port `5173`. Proxies `/api` and WebSocket events to the backend on `8085`.
*   **Start the Expo mobile packager:**
    ```bash
    bun dev:mobile
    ```
    Exposes the Metro bundler. Scan the QR code with your iOS Expo Go app to test it.

---

## 📦 Production & Native Builds

### Backend Server
To compile the production assets and bundle the server:
```bash
bun build:server
bun start:server
```

### Expo Native iOS Client
To generate the native Xcode workspace on your Mac:
```bash
cd apps/mobile
npx expo prebuild
```
This generates the native `apps/mobile/ios` directory. Open the workspace in Xcode, configure your signing credentials, compile the IPA, and install it on your device via AltStore.
