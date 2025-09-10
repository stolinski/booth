// Segmentation worker with high-quality portrait matting refinements
// Adds adaptive provider fallback (webgpu -> webgl -> wasm) with watchdog.
// Pipeline: letterbox -> normalize -> inference -> refine (feather) -> scale back.

import * as ort from 'onnxruntime-web';

// Configure ORT WASM base path and threading based on environment
async function configureOrtWasm() {
	try {
		const isolated = (self as any).crossOriginIsolated === true;
		// Always prefer local static assets; disable proxy to avoid .jsep.mjs imports
		(ort as any).env.wasm.wasmPaths = '/onnxruntime-web/';
		(ort as any).env.wasm.proxy = false;
		if (isolated) {
			ort.env.wasm.numThreads = 2;
			postPhase('wasm_config', 'local_threaded');
		} else {
			ort.env.wasm.numThreads = 1;
			postPhase('wasm_config', 'local_single_thread');
		}
	} catch {}
}

let session: ort.InferenceSession | null = null;
let loading: Promise<void> | null = null;
let adaptiveForcedWasm = false; // permanently force wasm after fallback trigger or explicit flag

function postPhase(phase: string, detail?: string) {
	(self as any).postMessage({ type: 'phase', phase, detail });
}

// Removed per-provider timeouts for stability during development.

async function fetchModelBlob(modelPath: string): Promise<Uint8Array> {
	const res = await fetch(modelPath);
	if (!res.ok) throw new Error(`fetch ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

async function createSession(modelBytes: Uint8Array) {
	await configureOrtWasm();
	// For stability, use WASM-only provider in dev.
	const combo = ['wasm'];
	try {
		(ort.env as any).logLevel = 'warning';
	} catch {}
	postPhase('provider_try', combo.join('+'));
	try {
		const isolated = (self as any).crossOriginIsolated === true;
		const threads = isolated ? 2 : 1;
		ort.env.wasm.numThreads = threads;
		postPhase('wasm_threads', String(threads));
		const sessionOptions: any = { executionProviders: combo, graphOptimizationLevel: 'all' };
		try {
			sessionOptions.enableMemPattern = false;
		} catch {}
		session = (await ort.InferenceSession.create(modelBytes, sessionOptions)) as any;
		(session as any)._providers = combo.join('+');
		postPhase('provider', combo.join('+'));
		return;
	} catch (e: any) {
		const msg = e?.message || String(e);
		postPhase('provider_fail', combo.join('+') + ' :: ' + msg);
		throw e;
	}
}

async function ensureLoaded(paths: string[]) {
	if (session) return;
	if (loading) return loading;
	loading = (async () => {
		let lastErr: any = null;
		for (const p of paths) {
			postPhase('fetch', p);
			try {
				const bytes = await fetchModelBlob(p);
				postPhase('init', p);
				await createSession(bytes);
				postPhase('ready', p);
				return;
			} catch (e: any) {
				lastErr = e;
				postPhase('source_fail', `${p} :: ${e?.message || e}`);
			}
		}
		postPhase('error', lastErr?.message || 'model load failed');
		throw lastErr || new Error('model load failed');
	})();
	try {
		await loading;
	} catch (e) {
		loading = null; // allow retry
		throw e;
	}
}

interface PreMeta {
	origW: number;
	origH: number;
	scale: number;
	dx: number;
	dy: number;
	target: number;
}

function preprocessLetterbox(
	imageBitmap: ImageBitmap,
	target = 1024,
	forceExact = false
): { tensor: ort.Tensor; meta: PreMeta } {
	const origW = imageBitmap.width;
	const origH = imageBitmap.height;
	const maxDim = Math.max(origW, origH);
	if (!forceExact) {
		if (target > maxDim * 1.15) target = Math.round(maxDim * 1.15);
	}
	const scale = target / maxDim;
	const scaledW = Math.round(origW * scale);
	const scaledH = Math.round(origH * scale);
	const dx = Math.floor((target - scaledW) / 2);
	const dy = Math.floor((target - scaledH) / 2);
	const canvas = new OffscreenCanvas(target, target);
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('no ctx');
	ctx.clearRect(0, 0, target, target);
	ctx.imageSmoothingQuality = 'high';
	ctx.drawImage(imageBitmap, 0, 0, origW, origH, dx, dy, scaledW, scaledH);
	const imgData = ctx.getImageData(0, 0, target, target);
	const data = new Float32Array(1 * 3 * target * target);
	let p = 0;
	for (let i = 0; i < imgData.data.length; i += 4) {
		const r = (imgData.data[i] / 255 - 0.5) / 0.5;
		const g = (imgData.data[i + 1] / 255 - 0.5) / 0.5;
		const b = (imgData.data[i + 2] / 255 - 0.5) / 0.5;
		data[p] = r;
		data[p + target * target] = g;
		data[p + 2 * target * target] = b;
		p++;
	}
	return {
		tensor: new ort.Tensor('float32', data, [1, 3, target, target]),
		meta: { origW, origH, scale, dx, dy, target }
	};
}

function gaussianBlurAlpha(alpha: Uint8ClampedArray, w: number, h: number, radius: number) {
	if (radius <= 0) return;
	const kernel: number[] = [];
	const sigma = radius;
	let sum = 0;
	for (let x = -radius; x <= radius; x++) {
		const v = Math.exp(-(x * x) / (2 * sigma * sigma));
		kernel.push(v);
		sum += v;
	}
	for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
	const tmp = new Float32Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let acc = 0;
			for (let k = -radius; k <= radius; k++) {
				const xx = Math.min(w - 1, Math.max(0, x + k));
				acc += alpha[y * w + xx] * kernel[k + radius];
			}
			tmp[y * w + x] = acc;
		}
	}
	for (let x = 0; x < w; x++) {
		for (let y = 0; y < h; y++) {
			let acc = 0;
			for (let k = -radius; k <= radius; k++) {
				const yy = Math.min(h - 1, Math.max(0, y + k));
				acc += tmp[yy * w + x] * kernel[k + radius];
			}
			alpha[y * w + x] = acc as unknown as number;
		}
	}
}

function refineAlphaBase(alphaTensor: ort.Tensor): {
	alpha: Uint8ClampedArray;
	w: number;
	h: number;
} {
	const [_, __, h, w] = alphaTensor.dims;
	const floatArr = alphaTensor.data as Float32Array;
	const alpha = new Uint8ClampedArray(w * h);
	for (let i = 0; i < w * h; i++) {
		let v = floatArr[i];
		if (!Number.isFinite(v)) v = 0;
		v = Math.min(1, Math.max(0, v));
		alpha[i] = v * 255;
	}
	return { alpha, w, h };
}

function boundaryFeather(alpha: Uint8ClampedArray, w: number, h: number) {
	const orig = new Uint8ClampedArray(alpha);
	const blurred = new Uint8ClampedArray(alpha);
	gaussianBlurAlpha(blurred, w, h, 1);
	for (let i = 0; i < alpha.length; i++) {
		const a = orig[i];
		if (a > 15 && a < 240) alpha[i] = (a * 0.6 + blurred[i] * 0.4) | 0;
	}
	for (let i = 0; i < alpha.length; i++) {
		const v = alpha[i] / 255;
		alpha[i] = Math.pow(v, 0.9) * 255;
	}
}

function composeToImageData(alpha: Uint8ClampedArray, w: number, h: number): ImageData {
	const img = new ImageData(w, h);
	for (let i = 0; i < w * h; i++) {
		img.data[i * 4 + 0] = 0;
		img.data[i * 4 + 1] = 0;
		img.data[i * 4 + 2] = 0;
		img.data[i * 4 + 3] = alpha[i];
	}
	return img;
}

function upscaleToOriginal(alpha512: ImageData, meta: PreMeta): ImageData {
	const { origW, origH, scale, dx, dy, target } = meta;
	const srcCanvas = new OffscreenCanvas(target, target);
	const sctx = srcCanvas.getContext('2d');
	if (!sctx) throw new Error('no sctx');
	sctx.putImageData(alpha512, 0, 0);
	const out = new OffscreenCanvas(origW, origH);
	const octx = out.getContext('2d');
	if (!octx) throw new Error('no octx');
	const scaledW = Math.round(origW * scale);
	const scaledH = Math.round(origH * scale);
	octx.imageSmoothingQuality = 'high';
	octx.drawImage(srcCanvas, dx, dy, scaledW, scaledH, 0, 0, origW, origH);
	return octx.getImageData(0, 0, origW, origH);
}

postPhase('boot', 'worker_online');

self.onmessage = async (e: MessageEvent) => {
	const { id, type, imageBitmap, modelPath, modelPaths, forceWasmOnly } = e.data;
	try {
		if (type === 'load') {
			if (forceWasmOnly) {
				adaptiveForcedWasm = true;
				postPhase('force_wasm_only', '1');
			}
			const paths: string[] = Array.isArray(modelPaths) ? modelPaths : modelPath ? [modelPath] : [];
			await ensureLoaded(paths);
			(self as any).postMessage({ id, ok: true });
			return;
		}
		if (type === 'segment') {
			const paths: string[] = Array.isArray(modelPaths) ? modelPaths : modelPath ? [modelPath] : [];
			await ensureLoaded(paths);
			if (!session) throw new Error('no session');
			if ((session as any)._ioShapesEmitted !== true) {
				try {
					const inputName = session.inputNames[0];
					const outputName = session.outputNames[0];
					postPhase('io_shapes', `${inputName}:${outputName}`);
				} catch {}
				(session as any)._ioShapesEmitted = true;
			}
			const target = 1024;
			const MAX_ATTEMPTS = 2; // original + optional fallback retry
			const WATCHDOG_SLOW_MS = 30000; // trigger fallback if >30s on non-wasm provider
			let attempt = 0;
			let lastError: any = null;
			while (attempt < MAX_ATTEMPTS) {
				attempt++;
				try {
					const { tensor, meta } = preprocessLetterbox(imageBitmap, target, true);
					const feeds: Record<string, ort.Tensor> = {};
					const inputName = session!.inputNames[0];
					feeds[inputName] = tensor;
					const t0 = performance.now();
					let results: Record<string, ort.Tensor> = (await session!.run(feeds)) as any;
					const inferMs = performance.now() - t0;
					postPhase('infer_ms', inferMs.toFixed(1));
					const provider = (session as any)._providers || '';
					if (!adaptiveForcedWasm && provider !== 'wasm' && inferMs > WATCHDOG_SLOW_MS) {
						postPhase('adaptive_fallback_trigger', 'slow_inference_' + inferMs.toFixed(0));
						adaptiveForcedWasm = true;
						try {
							await (session as any).release?.();
						} catch {}
						session = null;
						loading = null;
						postPhase('adaptive_fallback_reinit', 'wasm_only');
						await ensureLoaded(paths);
						if (!session) throw new Error('fallback rebuild failed');
						postPhase('adaptive_fallback_retry');
						continue; // go to next loop attempt
					}
					const outName = session!.outputNames[0];
					if (!results[outName]) {
						postPhase('segment_fail', `missing_output:${outName}`);
						throw new Error('missing output tensor');
					}
					let rawAlpha = results[outName];
					const data = rawAlpha.data as Float32Array;
					let needSigmoid = false;
					for (let i = 0; i < Math.min(512, data.length); i++) {
						const v = data[i];
						if (v < 0 || v > 1) {
							needSigmoid = true;
							break;
						}
					}
					if (needSigmoid) {
						const arr = new Float32Array(data.length);
						for (let i = 0; i < data.length; i++) arr[i] = 1 / (1 + Math.exp(-data[i]));
						rawAlpha = new ort.Tensor('float32', arr, rawAlpha.dims);
						postPhase('applied_sigmoid');
					}
					const refined = refineAlphaBase(rawAlpha);
					boundaryFeather(refined.alpha, refined.w, refined.h);
					const alphaImage = composeToImageData(refined.alpha, refined.w, refined.h);
					const scaledFirst = upscaleToOriginal(alphaImage, meta);

					// === Two-pass refinement ===
					let finalAlpha = scaledFirst;
					try {
						const passW = refined.w;
						const passH = refined.h;
						let minX = passW,
							minY = passH,
							maxX = -1,
							maxY = -1;
						const thresh = 24; // ~10% alpha
						for (let y = 0; y < passH; y++) {
							for (let x = 0; x < passW; x++) {
								const a = refined.alpha[y * passW + x];
								if (a > thresh) {
									if (x < minX) minX = x;
									if (x > maxX) maxX = x;
									if (y < minY) minY = y;
									if (y > maxY) maxY = y;
								}
							}
						}
						const hasFg = maxX >= minX && maxY >= minY;
						if (hasFg) {
							const { origW, origH, scale, dx, dy, target: tgt } = meta;
							minX = Math.max(minX, 0);
							minY = Math.max(minY, 0);
							maxX = Math.min(maxX, tgt - 1);
							maxY = Math.min(maxY, tgt - 1);
							let oMinX = Math.max(0, Math.floor((minX - dx) / scale));
							let oMaxX = Math.min(origW - 1, Math.ceil((maxX - dx) / scale));
							let oMinY = Math.max(0, Math.floor((minY - dy) / scale));
							let oMaxY = Math.min(origH - 1, Math.ceil((maxY - dy) / scale));
							const padRatio = 0.12;
							const bbW = oMaxX - oMinX + 1;
							const bbH = oMaxY - oMinY + 1;
							const padX = Math.round(bbW * padRatio);
							const padY = Math.round(bbH * padRatio);
							oMinX = Math.max(0, oMinX - padX);
							oMaxX = Math.min(origW - 1, oMaxX + padX);
							oMinY = Math.max(0, oMinY - padY);
							oMaxY = Math.min(origH - 1, oMaxY + padY);
							const cropW = oMaxX - oMinX + 1;
							const cropH = oMaxY - oMinY + 1;
							if (cropW < origW * 0.97 || cropH < origH * 0.97) {
								postPhase('refine_pass2_start', `${cropW}x${cropH}`);
								const cropCanvas = new OffscreenCanvas(cropW, cropH);
								const cctx = cropCanvas.getContext('2d');
								if (cctx) {
									cctx.drawImage(imageBitmap, oMinX, oMinY, cropW, cropH, 0, 0, cropW, cropH);
									const cropBitmap = cropCanvas.transferToImageBitmap();
									const { tensor: tensor2, meta: meta2 } = preprocessLetterbox(
										cropBitmap,
										1024,
										true
									);
									const feeds2: Record<string, ort.Tensor> = {};
									feeds2[session!.inputNames[0]] = tensor2;
									const t1 = performance.now();
									const results2 = await session!.run(feeds2);
									const inferMs2 = performance.now() - t1;
									postPhase('infer_ms_pass2', inferMs2.toFixed(1));
									let rawAlpha2 = results2[session!.outputNames[0]];
									if (rawAlpha2) {
										const refined2 = refineAlphaBase(rawAlpha2);
										boundaryFeather(refined2.alpha, refined2.w, refined2.h);
										const alphaImage2 = composeToImageData(refined2.alpha, refined2.w, refined2.h);
										const scaledCrop = upscaleToOriginal(alphaImage2, meta2); // cropW x cropH
										const merged = new ImageData(finalAlpha.width, finalAlpha.height);
										merged.data.set(finalAlpha.data);
										for (let yy = 0; yy < cropH; yy++) {
											for (let xx = 0; xx < cropW; xx++) {
												const srcIdx = (yy * cropW + xx) * 4 + 3; // alpha channel only
												const dstBase = ((yy + oMinY) * finalAlpha.width + (xx + oMinX)) * 4;
												merged.data[dstBase + 3] = scaledCrop.data[srcIdx];
											}
										}
										finalAlpha = merged;
										postPhase('refine_pass2_done');
									}
								}
							}
						}
					} catch (e: any) {
						postPhase('refine_pass2_error', e?.message || String(e));
					}

					(self as any).postMessage({ id, ok: true, alpha: finalAlpha }, []);
					return; // success, break out of while loop
				} catch (err: any) {
					lastError = err;
					const provider = (session as any)?._providers || '';
					const isTimeout = /timeout/i.test(err?.message || '');
					if (!adaptiveForcedWasm && provider !== 'wasm' && (isTimeout || attempt < MAX_ATTEMPTS)) {
						adaptiveForcedWasm = true;
						postPhase(
							'adaptive_fallback_trigger',
							(isTimeout ? 'timeout' : 'error') + ':' + (err?.message || '')
						);
						try {
							await (session as any).release?.();
						} catch {}
						session = null;
						loading = null;
						postPhase('adaptive_fallback_reinit', 'wasm_only');
						try {
							await ensureLoaded(paths);
							postPhase('adaptive_fallback_retry');
							continue; // retry loop
						} catch (re) {
							lastError = re;
							break; // cannot rebuild; exit loop
						}
					} else {
						break; // no fallback path -> exit loop
					}
				}
			}
			throw lastError || new Error('segmentation failed');
		}
	} catch (err: any) {
		postPhase('error', err?.message || 'segmentation error');
		self.postMessage({ id, ok: false, error: err?.message || 'segmentation error' });
	}
};
