// Worker-based high-quality segmentation engine wrapper
// MODNet portrait matting with multi-source fallback and phased status.

import { env as publicEnv } from '$env/dynamic/public';

function getModelSources(): string[] {
	function parseList(s: string): string[] {
		return s
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
	}
	const envRaw = (publicEnv.PUBLIC_RMBG_MODEL_URLS || publicEnv.PUBLIC_RMBG_MODEL_URL || '').trim();
	const envUrls = envRaw ? parseList(envRaw) : [];
	let qpUrls: string[] = [];
	try {
		const sp = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
		const one = sp.get('model') || sp.get('modelUrl') || '';
		const many = sp.get('models') || sp.get('modelUrls') || '';
		if (one) qpUrls.push(one);
		if (many) qpUrls.push(...parseList(many));
	} catch {}
	const urls = [...qpUrls, ...envUrls]; // query param first for quick testing
	return Array.from(new Set(urls));
}

export interface SegmentationResult {
	alpha: ImageData;
}

type PhaseListener = (phase: string, detail?: string) => void;

interface PendingReq {
	resolve: (v: SegmentationResult) => void;
	reject: (e: any) => void;
}

class SegmentationEngine {
	private worker: Worker | null = null;
	private req_id = 0;
	private pending = new Map<number, PendingReq>();
	private modelSources: string[] = getModelSources();
	private ready = false;
	private phaseListeners = new Set<PhaseListener>();

	isReady() {
		return this.ready;
	}
	private loading: Promise<void> | null = null;

	onPhase(cb: PhaseListener) {
		this.phaseListeners.add(cb);
		return () => this.phaseListeners.delete(cb);
	}

	private dispatchPhase(phase: string, detail?: string) {
		for (const l of this.phaseListeners) {
			try {
				l(phase, detail);
			} catch {}
		}
	}

	private ensureWorker() {
		if (this.worker) return;
		this.worker = new Worker(new URL('./segmentation/worker.ts', import.meta.url), {
			type: 'module'
		});
		this.worker.onmessage = (e: MessageEvent) => {
			const msg = e.data || {};
			if (msg.type === 'phase') {
				this.dispatchPhase(msg.phase, msg.detail);
				if (msg.phase === 'ready') this.ready = true;
				return;
			}
			const { id, ok, alpha, error } = msg;
			if (typeof id !== 'number') return;
			const pending = this.pending.get(id);
			if (!pending) {
				this.dispatchPhase('request_unmatched', String(id));
				return;
			}
			this.pending.delete(id);
			this.dispatchPhase('request_in', `${id}:${ok ? 'ok' : 'fail'}`);
			if (!ok) {
				pending.reject(new Error(error || 'segmentation failed'));
				return;
			}
			pending.resolve({ alpha });
		};
		this.worker.onerror = (e: ErrorEvent) => {
			const parts: string[] = [];
			parts.push(e?.message || 'worker error');
			const loc = `${e?.filename || ''}:${e?.lineno || ''}:${e?.colno || ''}`;
			if (loc !== '::') parts.push(loc);
			const stack = (e as any)?.error?.stack || '';
			if (stack) parts.push(stack);
			const detail = parts.join(' | ');
			this.dispatchPhase('worker_error', detail);
		};
		this.worker.onmessageerror = () => {
			this.dispatchPhase('worker_message_error', 'malformed message');
		};
	}

	async loadModel(opts?: { forceWasmOnly?: boolean; timeoutMs?: number }) {
		if (this.ready) return;
		if (this.loading) return this.loading;
		this.ensureWorker();
		const qpForce = (() => {
			try {
				const sp = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
				const v = sp.get('wasmonly') || sp.get('wasm') || '';
				return v === '1' || v === 'true';
			} catch {
				return false;
			}
		})();
		const forceWasmOnly = opts?.forceWasmOnly === true || qpForce;
		// Resolve and validate model sources. If empty, fail fast with guidance.
		const sources = this.modelSources;
		if (!sources || sources.length === 0) {
			this.dispatchPhase('config_error_no_model_urls', 'Set PUBLIC_RMBG_MODEL_URL or ?model=');
			throw new Error('no model URLs configured');
		}
		this.dispatchPhase('model_sources', sources.join(','));
		// No hard timeout for model load in dev; rely on worker phases.
		const TIMEOUT_MS = 0;
		this.loading = new Promise<void>((resolve, reject) => {
			const id = ++this.req_id;
			let timer: any;
			const wrapResolve = () => {
				if (timer) clearTimeout(timer);
				this.ready = true;
				resolve();
			};
			const wrapReject = (e: any) => {
				if (timer) clearTimeout(timer);
				this.loading = null;
				reject(e);
			};
			this.pending.set(id, { resolve: wrapResolve as any, reject: wrapReject });
			if (TIMEOUT_MS > 0) {
				timer = setTimeout(() => {
					if (this.pending.has(id)) {
						this.pending.delete(id);
						this.dispatchPhase('error', 'model load timeout');
						wrapReject(new Error('model load timeout'));
					}
				}, TIMEOUT_MS);
			}
			this.worker!.postMessage({ id, type: 'load', modelPaths: sources, forceWasmOnly });
		});
		return this.loading;
	}

	segment(imageBitmap: ImageBitmap): Promise<SegmentationResult> {
		this.ensureWorker();
		return new Promise((resolve, reject) => {
			const id = ++this.req_id;
			this.pending.set(id, { resolve, reject });
			this.dispatchPhase('request_out', String(id));
			const TIMEOUT_MS = 180000; // allow up to 3 minutes for slow first inference
			const timer = setTimeout(() => {
				if (this.pending.has(id)) {
					this.pending.delete(id);
					this.dispatchPhase('segment_timeout', String(id));
					reject(new Error('segment timeout'));
				}
			}, TIMEOUT_MS);
			this.worker!.postMessage(
				{
					id,
					type: 'segment',
					imageBitmap,
					width: imageBitmap.width,
					height: imageBitmap.height,
					modelPaths: this.modelSources
				},
				[imageBitmap]
			);
			// Clear timeout on settle
			const wrapResolve = (v: any) => {
				clearTimeout(timer);
				resolve(v);
			};
			const wrapReject = (e: any) => {
				clearTimeout(timer);
				reject(e);
			};
			// Replace the stored handlers so onmessage uses cleared timer
			this.pending.set(id, { resolve: wrapResolve, reject: wrapReject });
		});
	}
}

export const segmentationEngine = new SegmentationEngine();
