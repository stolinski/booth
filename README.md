# Booth

A browser-based “photo booth” that guides a user through capturing a fixed set of poses/emotions, writes PNGs to a user-chosen local folder (via the File System Access API), and post-processes them to transparent cutouts using an ONNX portrait matting model running in a Web Worker.

Design inspired by https://thomasmcinnis.com/posts/teenage-engineering-calculator/

**Quick Start**

- **Prereqs:** Bun 1.1+ (bundled Node API), modern Chromium-based browser. File System Access API and OffscreenCanvas are required for full functionality.
- **Install:** `bun install` (or `bun i`).
- **Dev:** `bun run dev` then open the printed URL.
- **Build:** `bun run build` • **Preview:** `bun run preview`
- **First run:**
  - Click “pick root folder” and grant read/write permissions.
  - Start camera, select device if needed.
  - “capture all emotions (today)” to create the daily set.
  - “process cutouts” to generate transparent PNGs under `YYYY-MM-DD/cutout/`.

**Architecture**

- **UI (SvelteKit v2 + Svelte 5 runes):** Main flow lives in `src/routes/+page.svelte` with small components in `src/lib/components/`.
- **State:** `src/lib/DateState.svelte.ts` centralizes selected day and the list of days.
- **Persistence:**
  - Root directory handle is cached in IndexedDB (best-effort; permission is re-validated each start).
  - Photos are saved under the chosen root as `YYYY-MM-DD/<emotion>.png`.
  - Cutouts are saved to `YYYY-MM-DD/cutout/<emotion>.png`.
- **Segmentation:**
  - `src/lib/SegmentationEngine.ts` wraps a Web Worker (`src/lib/segmentation/worker.ts`).
  - Model: `static/models/rmbg14.onnx` (default). You can override via `PUBLIC_RMBG_MODEL_URL` or comma-separated `PUBLIC_RMBG_MODEL_URLS`; the local file remains as a fallback. Worker prefers WASM-only provider for stability.
  - ORT runtime assets are served from `static/onnxruntime-web/` and configured via `ort.env.wasm.wasmPaths`.
  - The worker preprocesses, runs inference, refines edges, and scales the alpha matte back to the original size.
- **COOP/COEP:**
  - Dev/preview set headers in `vite.config.ts` for `crossOriginIsolated` so WASM can use threads.
  - In production, `src/hooks.server.ts` sets COOP/COEP when `!dev`.
- **Adapter:** Cloudflare (`@sveltejs/adapter-cloudflare`).

**Repository Status (Assessment)**

- **What’s solid:**
  - End-to-end capture → file write flow with per-day organization.
  - Web Worker segmentation with clear phase/status reporting and fallback to WASM.
  - Headers strategy for crossOriginIsolation in dev/preview and prod.
  - Svelte 5 runes usage feels cohesive across components.
- **Rough edges / issues:**
  - Typo in status UI: "Eroror" (should be "Error").
  - Inconsistent imports for date state: `'$lib/DateState.svelte'` vs `'$lib/DateState.svelte.ts'`.
  - `static/models/rmbg2016.onnx` is currently unused; only `rmbg14.onnx` is referenced.
  - `vite-plugin-devtools-json` is included but not used in the codebase.
  - A stray file named `'` appears at repo root (likely accidental).
  - Mixed lockfile story: `bun.lock` is committed but `package.json` does not declare a package manager. Consider standardizing on one (Bun, pnpm, or npm).
- **Potential correctness/perf concerns:**
  - OffscreenCanvas `convertToBlob()` may vary across browsers; this project targets Chromium where it’s supported.
  - WebGPU/WebGL pathways are disabled in the worker right now. That’s intentional for stability, but keep in mind performance tradeoffs on capable devices.

**ORT Runtime Files (WASM-only minimal set)**

- The project now ships a trimmed `static/onnxruntime-web/` for WASM-only execution (no WebGPU/WebGL/bundles). Kept files:
  - `ort.wasm.min.js`
  - `ort.wasm.min.mjs`
  - `ort-wasm-simd-threaded.wasm`
  - `ort-wasm-simd-threaded.mjs`
- Source maps are optional and removed to reduce size.
- If you ever switch providers or see 404s in Network devtools, re-add only what `onnxruntime-web` fetches with `env.wasm.proxy = false`.

**What’s Extraneous (post-trim)**

- `static/models/rmbg2016.onnx` is intentionally kept as-is per request but remains unused by default.
- `vite-plugin-devtools-json` dependency and plugin registration if there’s no JSON devtools usage.

**Recommended Next Steps**

- **Polish & correctness:**
  - Fix the “Eroror” typo in `src/routes/+page.svelte` status area.
  - Standardize imports to `'$lib/DateState.svelte'` (or the explicit `.svelte.ts`) consistently across files.
- **Reduce bundle/static weight:**
  - Keep monitoring Network requests to ensure no missing ORT assets after the trim.
  - Remove `vite-plugin-devtools-json` if not needed.
- **DX & consistency:**
  - Choose a single package manager; add "packageManager": "bun@<version>" (or `pnpm@…`/`npm@…`) to `package.json` and commit the corresponding lockfile only.
  - Add a minimal CI workflow to run `bun run lint` and `bun run check` on PRs.
- **UX improvements:**
  - Surface segmentation errors per-emotion in the gallery with a retry button.
  - Consider a small progress indicator overlay during “process cutouts”.
  - Option to tweak the emotion list without code changes (config file or UI).
- **Architecture:**
  - Move the emotion list and some of the camera/file helpers out of `+page.svelte` into small `$lib` modules/stores for testability.
  - Add an abstraction for the file layout (day folders, filenames) so it’s easier to adjust later.

**Deploying**

- Cloudflare adapter targets Workers; ensure static assets under `static/` (models and ORT files) are uploaded and cached. COOP/COEP are set by `hooks.server.ts` in production.
- Smaller static payload after trimming `static/onnxruntime-web/` reduces upload time and cache footprint.

**Troubleshooting**

- If model never becomes ready:
  - Check the Network tab for 404s under `/onnxruntime-web/` and `/models/`.
  - Try `?wasmonly=1` in the URL to force the WASM-only path (also the worker already prefers WASM).
- If file writes fail: re-pick the root directory to refresh permissions.
- If the app isn’t `crossOriginIsolated` in dev, make sure dev server printed the COOP/COEP headers (Vite config sets them). Some extensions or proxies can strip them.

**File Map (selected)**

- `src/routes/+page.svelte`: Main flow, camera, session orchestration, and calling segmentation.
- `src/lib/components/*`: Small UI components (camera controls, video capture, gallery, status).
- `src/lib/DateState.svelte.ts`: Central day selection/list state.
- `src/lib/SegmentationEngine.ts`: Worker wrapper and model lifecycle.
- `src/lib/segmentation/worker.ts`: ONNX runtime setup and matting pipeline.
- `static/models/*`: ONNX models (currently using `rmbg14.onnx`).
- `static/onnxruntime-web/*`: Minimal ORT browser runtime files for WASM.

This README reflects the new minimal ORT set and keeps `rmbg2016.onnx` untouched. I can also fix the small code nits (typo, imports) in a follow-up if you want.

---

**Cloudflare R2 CORS (exact JSON)**

```json
[
	{
		"AllowedOrigins": ["*"],
		"AllowedMethods": ["GET", "HEAD"],
		"ExposeHeaders": ["ETag", "Content-Length", "Accept-Ranges", "Content-Range"],
		"MaxAgeSeconds": 86400
	}
]
```
