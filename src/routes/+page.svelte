<script lang="ts">
	import FileDirectoryManager from '$lib/components/FileDirectoryManager.svelte';
	import CameraControls from '$lib/components/CameraControls.svelte';
	import VideoCapture from '$lib/components/VideoCapture.svelte';
	import EmotionGallery from '$lib/components/EmotionGallery.svelte';
	import StatusBar from '$lib/components/StatusBar.svelte';
	import { dateState } from '$lib/DateState.svelte';
	// svelte 5 runes version (snake_case everywhere, no css)

	// static config (emotion list)
	const emotion_list = [
		'happy',
		'surprised',
		'confused',
		'angry',
		'excited',
		'shocked',
		'thoughtful',
		'pointing',
		'thumbs_up'
	];

	// camera + session state (local)
	let video_el = $state<HTMLVideoElement | null>(null);
	let media_stream = $state<MediaStream | null>(null);
	let video_devices = $state<MediaDeviceInfo[]>([]);
	let selected_device_id = $state('');

	let countdown_value = $state(0);
	let flash_active = $state(false);
	let session_running = $state(false);
	let current_emotion_index = $state(0);
	let status_msg = $state('');

	// derived current emotion
	const current_emotion = $derived(emotion_list[current_emotion_index] || '');

	// filesystem + photos (remain local except selected_day via dateState)
	let root_handle = $state<FileSystemDirectoryHandle | null>(null);
	let day_photos = $state<Record<string, { handle: FileSystemFileHandle; url: string }>>({});

	// selected_day externalized (list also external now)

	// cutout processing state
	let processing_cutouts = $state(false);
	let model_loading = $state(true);
	let model_error = $state('');

	// ===== idb persistence =====
	const DB_NAME = 'photo_booth';
	const STORE = 'handles';

	function open_db(): Promise<IDBDatabase> {
		// legacy path during migration
		return new Promise((resolve, reject) => {
			const req = indexedDB.open(DB_NAME, 1);
			req.onupgradeneeded = () => {
				const db = req.result;
				if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () => reject(req.error);
		});
	}

	async function save_root_handle(handle: FileSystemDirectoryHandle) {
		// legacy path during migration
		try {
			const db = await open_db();
			const tx = db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put(handle, 'root');
		} catch {}
	}

	async function load_root_handle(): Promise<FileSystemDirectoryHandle | null> {
		// legacy path during migration
		try {
			const db = await open_db();
			return await new Promise((resolve, reject) => {
				const tx = db.transaction(STORE, 'readonly');
				const req = tx.objectStore(STORE).get('root');
				req.onsuccess = () => resolve(req.result || null);
				req.onerror = () => reject(req.error);
			});
		} catch {
			return null;
		}
	}

	// ===== utils =====
	function today_str(): string {
		// use local timezone instead of UTC truncation to avoid day rollover issues
		const d = new Date();
		const y = d.getFullYear();
		const m = String(d.getMonth() + 1).padStart(2, '0');
		const day = String(d.getDate()).padStart(2, '0');
		return `${y}-${m}-${day}`;
	}

	async function ensure_permission(dir: FileSystemDirectoryHandle) {
		// @ts-ignore
		const perm = await dir.queryPermission?.({ mode: 'readwrite' });
		if (perm !== 'granted') {
			// @ts-ignore
			const p2 = await dir.requestPermission?.({ mode: 'readwrite' });
			if (p2 !== 'granted') throw new Error('permission denied');
		}
	}

	async function pick_root() {
		try {
			const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker();
			root_handle = handle;
			await ensure_permission(root_handle);
			await save_root_handle(root_handle);
			await load_days();
			dateState.setSelectedDay(today_str());
			await load_day_photos(dateState.selected_day);
			status_msg = 'root selected';
		} catch {
			status_msg = 'root selection cancelled';
		}
	}

	async function load_days() {
		if (!root_handle) {
			dateState.setDayList([]);
			return;
		}
		const list: string[] = [];
		for await (const [name, entry] of (root_handle as any).entries()) {
			if (entry.kind === 'directory' && /^\d{4}-\d{2}-\d{2}$/.test(name)) list.push(name);
		}
		list.sort().reverse();
		if (!list.includes(today_str())) list.unshift(today_str());
		dateState.setDayList(list);
	}

	async function get_day_dir(date: string, create = true) {
		// proxy
		if (!root_handle) throw new Error('no root directory');
		return await root_handle.getDirectoryHandle(date, { create });
	}

	function revoke_day_urls() {
		// proxy
		for (const k in day_photos) URL.revokeObjectURL(day_photos[k].url);
		day_photos = {};
	}

	async function load_day_photos(date: string) {
		// proxy
		revoke_day_urls();
		if (!root_handle) return;
		try {
			const dir = await get_day_dir(date, false);
			for await (const [name, entry] of (dir as any).entries()) {
				if (entry.kind === 'file' && name.toLowerCase().endsWith('.png')) {
					const emotion = emotion_list.find((e) => `${e}.png` === name.toLowerCase());
					if (emotion) {
						const fh = await dir.getFileHandle(name);
						const file = await fh.getFile();
						day_photos[emotion] = { handle: fh, url: URL.createObjectURL(file) };
					}
				}
			}
		} catch {}
	}

	// ===== camera handling =====
	async function enumerate_video_devices() {
		// proxy
		try {
			const list = await navigator.mediaDevices.enumerateDevices();
			video_devices = list.filter((d) => d.kind === 'videoinput');
			// attempt to restore last used device if available
			let last = '';
			try {
				last = localStorage.getItem('last_camera_device') || '';
			} catch {}
			if (last && video_devices.some((d) => d.deviceId === last)) {
				selected_device_id = last;
			} else if (!selected_device_id && video_devices.length) {
				selected_device_id = video_devices[0].deviceId;
			}
		} catch {
			status_msg = 'device enumeration failed';
		}
	}

	async function start_stream() {
		// proxy
		if (media_stream) {
			media_stream.getTracks().forEach((t) => t.stop());
			media_stream = null;
		}
		try {
			media_stream = await navigator.mediaDevices.getUserMedia({
				video: { deviceId: selected_device_id ? { exact: selected_device_id } : undefined }
			});
			if (video_el) {
				video_el.srcObject = media_stream;
				await video_el.play();
			}
			try {
				if (selected_device_id) localStorage.setItem('last_camera_device', selected_device_id);
			} catch {}
			await enumerate_video_devices();
			status_msg = 'camera ready';
		} catch {
			status_msg = 'camera error';
		}
	}

	// ===== capture logic =====
	async function countdown_and_capture(emotion: string, date: string) {
		// proxy
		// ensure overlay emotion matches even for single retake
		current_emotion_index = emotion_list.indexOf(emotion);
		countdown_value = 3;
		for (let i = 3; i > 0; i--) {
			countdown_value = i;
			await new Promise((r) => setTimeout(r, 1000));
		}
		countdown_value = 0;
		flash_active = true;
		setTimeout(() => (flash_active = false), 120);
		await capture_emotion(emotion, date);
	}

	async function capture_emotion(emotion: string, date: string) {
		// proxy
		if (!media_stream) throw new Error('no stream');
		if (!root_handle) throw new Error('no root');
		const track = media_stream.getVideoTracks()[0];
		const settings = track.getSettings();
		const el = video_el;
		const width = (el?.videoWidth || settings.width || 1280) as number;
		const height = (el?.videoHeight || settings.height || 720) as number;
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no context');
		ctx.drawImage(el, 0, 0, width, height);
		const blob: Blob = await new Promise((res) => canvas.toBlob((b) => res(b!), 'image/png'));
		const dir = await get_day_dir(date, true);
		const file_name = `${emotion}.png`;
		const fh = await dir.getFileHandle(file_name, { create: true });
		const writable = await fh.createWritable();
		await writable.write(blob);
		await writable.close();
		const file = await fh.getFile();
		if (day_photos[emotion]) URL.revokeObjectURL(day_photos[emotion].url);
		day_photos[emotion] = { handle: fh, url: URL.createObjectURL(file) };
	}

	async function run_session() {
		if (!root_handle) {
			status_msg = 'pick root first';
			return;
		}
		if (!media_stream) {
			status_msg = 'start camera first';
			return;
		}
		session_running = true;
		current_emotion_index = 0;
		const date = today_str();
		dateState.setSelectedDay(date);
		await load_days();
		for (let i = 0; i < emotion_list.length; i++) {
			current_emotion_index = i;
			status_msg = `pose: ${emotion_list[i]}`;
			await countdown_and_capture(emotion_list[i], date);
		}
		status_msg = 'session complete';
		session_running = false;
		await load_days();
		await load_day_photos(date);
		// auto process after full session
		process_day_cutouts(date);
	}

	async function retake_one(emotion: string) {
		if (!media_stream) {
			status_msg = 'start camera';
			return;
		}
		if (!dateState.selected_day) {
			status_msg = 'select day';
			return;
		}
		status_msg = `retake: ${emotion}`;
		await countdown_and_capture(emotion, dateState.selected_day);
		status_msg = `${emotion} updated`;
	}

	async function retake_all_for_day() {
		if (!media_stream) {
			status_msg = 'start camera';
			return;
		}
		if (!dateState.selected_day) {
			status_msg = 'select day';
			return;
		}
		session_running = true;
		for (let i = 0; i < emotion_list.length; i++) {
			current_emotion_index = i;
			status_msg = `retake: ${emotion_list[i]}`;
			await countdown_and_capture(emotion_list[i], dateState.selected_day);
		}
		session_running = false;
		status_msg = 'all retaken';
		// auto process after bulk retake
		process_day_cutouts(dateState.selected_day);
	}

	async function change_day(day: string) {
		dateState.setSelectedDay(day);
		await load_day_photos(day);
	}

	// ===== cutout processing (post-session or manual) =====
	import { segmentationEngine } from '$lib/SegmentationEngine';

	let model_phase = $state('');
	let model_phase_detail = $state('');
	let model_provider = $state('');
	let model_model_path = $state('');

	const offPhase = segmentationEngine.onPhase((p, d) => {
		try {
			const detail = typeof d === 'string' ? d : d ? JSON.stringify(d) : '';
			console.log('[segmentation][phase]', p, detail);
			model_phase = p;
			model_phase_detail = detail;
			if (p === 'provider') model_provider = detail;
			if (p === 'ready') {
				model_loading = false;
				model_error = '';
				model_model_path = model_phase_detail || model_model_path;
				status_msg = 'model ready';
			} else if (p === 'error') {
				// Show error detail but do not override camera-related status
				model_loading = false;
				model_error = detail || 'model error';
			} else if (p === 'source_fail') {
				// show last failure if no model succeeded yet
				if (!model_provider && !segmentationEngine.isReady()) model_error = detail || '';
			}
		} catch (err) {
			console.error('[segmentation][phase][handler_error]', err);
		}
	});

	async function process_day_cutouts(day: string) {
		console.log('[cutouts] start', { day, ready: segmentationEngine.isReady() });
		if (processing_cutouts) return;
		if (!root_handle) return;
		if (!segmentationEngine.isReady()) {
			console.log('[cutouts] model not ready, initiating load');
			status_msg = 'loading model...';
			try {
				await segmentationEngine.loadModel();
			} catch (e) {
				model_error = (e as any)?.message || 'model unavailable';
				status_msg = 'model unavailable (fallback)';
				// Continue anyway to surface errors during segment attempts
			}
		}
		processing_cutouts = true;
		console.log('[cutouts] processing loop begin');
		status_msg = 'processing cutouts...';
		try {
			const day_dir = await get_day_dir(day, false);
			const cutout_dir = await day_dir.getDirectoryHandle('cutout', { create: true });
			let processed = 0;
			const total = emotion_list.length;
			for (const emo of emotion_list) {
				console.log('[cutouts] emotion start', emo);
				const photo = day_photos[emo];
				if (!photo) {
					console.log('[cutouts] missing photo', emo);
					processed++;
					status_msg = `processing cutouts... (${processed}/${total})`;
					continue;
				}
				try {
					const file = await photo.handle.getFile();
					console.log('[cutouts] file acquired', emo, file.size);
					const bitmap = await createImageBitmap(file);
					console.log('[cutouts] bitmap created', emo, bitmap.width, bitmap.height);
					// Draw BEFORE segmentation because bitmap will be transferred to worker (detached afterwards)
					const pre_canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
					const pre_ctx = pre_canvas.getContext('2d');
					if (!pre_ctx) {
						processed++;
						status_msg = `processing cutouts... (${processed}/${total})`;
						continue;
					}
					pre_ctx.drawImage(bitmap, 0, 0);
					// Now run segmentation (transfers bitmap)
					const { alpha } = await segmentationEngine.segment(bitmap);
					console.log('[cutouts] segmentation done', emo, alpha.width, alpha.height);
					const src = pre_ctx.getImageData(0, 0, pre_canvas.width, pre_canvas.height);
					const data = src.data;
					for (let i = 0; i < data.length; i += 4) data[i + 3] = alpha.data[i + 3];
					pre_ctx.putImageData(src, 0, 0);
					const blob: Blob = await pre_canvas.convertToBlob({ type: 'image/png' });
					console.log('[cutouts] blob size', emo, blob.size);
					const fh = await cutout_dir.getFileHandle(`${emo}.png`, { create: true });
					const writable = await fh.createWritable();
					await writable.write(blob);
					await writable.close();
					processed++;
					status_msg = `processing cutouts... (${processed}/${total})`;
				} catch (err) {
					console.log('[cutouts] segmentation error', emo, err);
					processed++;
					status_msg = `processing cutouts... (${processed}/${total})`;
					continue;
				}
			}
			if (processed === 0) status_msg = 'no cutouts created';
			else status_msg = 'cutouts complete';
		} catch (e: any) {
			status_msg = 'cutouts failed';
			if (!model_error && (e as any)?.message) model_error = (e as any).message;
		} finally {
			processing_cutouts = false;
		}
	}

	async function retry_model() {
		model_loading = true;
		model_error = '';
		status_msg = 'retrying model load';
		try {
			await segmentationEngine.loadModel();
		} catch (e: any) {
			model_loading = false;
			model_error = e?.message || 'model load failed';
		}
	}

	$effect.root(() => {
		let active = true;
		(async () => {
			const h = await load_root_handle();
			if (!active) return;
			if (h) {
				root_handle = h;
				try {
					await ensure_permission(root_handle);
				} catch {
					root_handle = null;
				}
			}
			if (root_handle) {
				await load_days();
				dateState.setSelectedDay(today_str());
				await load_day_photos(dateState.selected_day);
			}
			try {
				await start_stream();
			} catch {}
			segmentationEngine.loadModel().catch((e) => {
				console.warn('[segmentation][load][deferred_error]', e);
			});
		})();
		return () => {
			active = false;
			media_stream?.getTracks().forEach((t) => t.stop());
			revoke_day_urls();
		};
	});
</script>

<div class="device">
	<StatusBar {status_msg}>
		<p>
			ai:
			{#if model_loading || model_phase || model_error}
				{#if model_phase === 'provider_webgpu_init_fail'}WebGPU init fail: {model_phase_detail}{/if}
				{#if model_phase === 'provider_fail'}Provider failed: {model_phase_detail}{/if}
				{#if model_phase === ''}Loading matting model…{/if}
				{#if model_phase === 'fetch'}Fetching: {model_phase_detail}{/if}
				{#if model_phase === 'init'}Initializing session…{/if}
				{#if model_phase === 'provider_try'}Trying providers: {model_phase_detail}{/if}
				{#if model_phase === 'provider'}Provider: {model_provider}{/if}
				{#if model_phase === 'infer_ms'}Last inference: {model_phase_detail} ms{/if}
				{#if model_phase === 'source_fail'}Source failed: {model_phase_detail}{/if}
				{#if model_provider && !model_error}
					<span>
						Phase: {model_phase}
						{#if model_phase_detail}({model_phase_detail}){/if}
					</span>

					<span>
						Loaded model: {model_model_path} via {model_provider}
					</span>
				{/if}
			{:else if model_error}
				<span>
					Error: {model_error}
				</span>
			{:else}
				{'__'}
			{/if}
		</p>
	</StatusBar>
	<FileDirectoryManager {root_handle} {pick_root} />
	<CameraControls bind:selected_device_id {video_devices} {start_stream} {session_running} />
	<VideoCapture
		bind:video_el
		{countdown_value}
		{flash_active}
		{current_emotion}
		{run_session}
		{retake_all_for_day}
		{root_handle}
		{session_running}
		process_day_cutouts={() =>
			dateState.selected_day && process_day_cutouts(dateState.selected_day)}
		{processing_cutouts}
	/>
	<EmotionGallery
		{emotion_list}
		{day_photos}
		{retake_one}
		{session_running}
		{current_emotion_index}
		{media_stream}
		day_list={dateState.day_list}
		{change_day}
	/>
</div>

<style>
	.device {
		background: var(--bg);
		padding: 20px;
		margin: 1rem;
		border-radius: 2px;
		box-shadow: var(--shadow-body);
	}
</style>
