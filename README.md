# Leaf Desk (Tauri)

MongoDB desktop client: React UI, embedded Node mongo-api (no console window).

## Develop

```bash
npm install
npm run build:api
npm run dev
```

## Release

```bash
npm run build:client
```

Installer: `src-tauri/target/release/bundle/nsis/LeafDesk_1.0.0_x64-setup.exe`

Launch without a console: `Launch-LeafDesk.cmd`

First run imports `leaf-desk-*` localStorage keys from the legacy Electron app (`%APPDATA%/mongodb`).
