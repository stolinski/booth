AGENTS for this repo (SvelteKit v2 + Svelte 5)

When connected to the svelte-llm MCP server, you have access to comprehensive Svelte 5 and SvelteKit documentation. Here's how to use the available tools effectively:

## Available MCP Tools

### 1. list_sections

Use this FIRST to discover all available documentation sections. Returns a structured list with titles and paths.
When asked about Svelte or SvelteKit topics, ALWAYS use this tool at the start of the chat to find relevant sections.

### 2. get_documentation

Retrieves full documentation content for specific sections. Accepts single or multiple sections.
After calling the list_sections tool, you MUST analyze the returned documentation sections and then use the get_documentation tool to fetch ALL documentation sections that are relevant for the users task.

- Dev: `bun run dev` • Build: `bun run build` • Preview: `bun run preview`
- Lint: `bun run lint` (Prettier check + ESLint) • Format: `bun run format`
- Typecheck: `bun run check` • Watch: `bun run check:watch`
- Tests: none configured; when adding Vitest: `bunx vitest`, single file: `bunx vitest path/to/file.test.ts`, single test: `bunx vitest -t "name"`
- Single-file lint/format: `bunx eslint path` (add `--fix`) • `bunx prettier --write path`
- ESM only (`"type":"module"`); prefer `$lib/...` for internal modules, relative for siblings
- Import order: std libs → external → `$lib` → relative; avoid deep `../..` chains
- Formatting (Prettier): useTabs=true, singleQuote=true, trailingComma=none, printWidth=100
- Svelte formatting via `prettier-plugin-svelte`; format `.svelte` files too
- ESLint: `@eslint/js` + `typescript-eslint` + `eslint-plugin-svelte`; `no-undef` off for TS
- Types: TS `strict` on; `allowJs`+`checkJs` enabled—keep JSDoc types in JS when editing
- Prefer explicit return types for exported APIs; avoid `any`, prefer `unknown` and narrow
- Error handling: try/catch async; show user-facing messages via `StatusBar`; `console.error` for diagnostics
- Components: PascalCase `.svelte`; Svelte runes modules as `*.svelte.ts`; workers live in `src/lib/segmentation/`
- Modules: classes PascalCase (e.g., `SegmentationEngine.ts`); pure utils kebab-case filenames
- Imports must be side‑effect‑free; do not import Svelte in Web Workers
- Runtime assets: keep ONNX runtime under `static/onnxruntime-web/`; reference via `/onnxruntime-web/...`
- COOP/COEP: keep headers in `vite.config.ts` and `src/hooks.server.ts` to stay `crossOriginIsolated`
- Cursor/Copilot rules: none present (`.cursor/`, `.cursorrules`, `.github/copilot-instructions.md` not found)
