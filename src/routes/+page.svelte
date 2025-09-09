<script lang="ts">
	// svelte 5 runes version (snake_case everywhere, no css)

	// ===== config =====
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

	// ===== camera state (runes) =====
	let video_el: HTMLVideoElement; // element ref (not a rune)
	let media_stream = $state<MediaStream | null>(null);
	let video_devices = $state<MediaDeviceInfo[]>([]);
	let selected_device_id = $state('');

	// ===== capture/session state =====
	let countdown_value = $state(0);
	let flash_active = $state(false);
	let session_running = $state(false);
	let current_emotion_index = $state(0);
	let status_msg = $state('');

	// live derived emotion for overlays
	const current_emotion = $derived(emotion_list[current_emotion_index] || '');

	// ===== file system state =====
	let root_handle = $state<FileSystemDirectoryHandle | null>(null);
	let day_list = $state<string[]>([]);
	let selected_day = $state('');
	let day_photos = $state<Record<string, { handle: FileSystemFileHandle; url: string }>>({});

	// ===== idb persistence =====
	const DB_NAME = 'photo_booth';
	const STORE = 'handles';

	function open_db(): Promise<IDBDatabase> {
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
		try {
			const db = await open_db();
			const tx = db.transaction(STORE, 'readwrite');
			tx.objectStore(STORE).put(handle, 'root');
		} catch {}
	}

	async function load_root_handle(): Promise<FileSystemDirectoryHandle | null> {
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
			selected_day = today_str();
			await load_day_photos(selected_day);
			status_msg = 'root selected';
		} catch {
			status_msg = 'root selection cancelled';
		}
	}

	async function load_days() {
		day_list = [];
		if (!root_handle) return;
		for await (const [name, entry] of (root_handle as any).entries()) {
			if (entry.kind === 'directory' && /^\d{4}-\d{2}-\d{2}$/.test(name)) day_list.push(name);
		}
		day_list.sort().reverse();
		if (!day_list.includes(today_str())) day_list.unshift(today_str());
	}

	async function get_day_dir(date: string, create = true) {
		if (!root_handle) throw new Error('no root directory');
		return await root_handle.getDirectoryHandle(date, { create });
	}

	function revoke_day_urls() {
		for (const k in day_photos) URL.revokeObjectURL(day_photos[k].url);
		day_photos = {};
	}

	async function load_day_photos(date: string) {
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
		try {
			const list = await navigator.mediaDevices.enumerateDevices();
			video_devices = list.filter((d) => d.kind === 'videoinput');
			if (!selected_device_id && video_devices.length)
				selected_device_id = video_devices[0].deviceId;
		} catch {
			status_msg = 'device enumeration failed';
		}
	}

	async function start_stream() {
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
			await enumerate_video_devices();
			status_msg = 'camera ready';
		} catch {
			status_msg = 'camera error';
		}
	}

	// ===== capture logic =====
	async function countdown_and_capture(emotion: string, date: string) {
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
		if (!media_stream) throw new Error('no stream');
		if (!root_handle) throw new Error('no root');
		const track = media_stream.getVideoTracks()[0];
		const settings = track.getSettings();
		const width = (video_el?.videoWidth || settings.width || 1280) as number;
		const height = (video_el?.videoHeight || settings.height || 720) as number;
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('no context');
		ctx.drawImage(video_el, 0, 0, width, height);
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
		selected_day = date;
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
	}

	async function retake_one(emotion: string) {
		if (!media_stream) {
			status_msg = 'start camera';
			return;
		}
		if (!selected_day) {
			status_msg = 'select day';
			return;
		}
		status_msg = `retake: ${emotion}`;
		await countdown_and_capture(emotion, selected_day);
		status_msg = `${emotion} updated`;
	}

	async function retake_all_for_day() {
		if (!media_stream) {
			status_msg = 'start camera';
			return;
		}
		if (!selected_day) {
			status_msg = 'select day';
			return;
		}
		session_running = true;
		for (let i = 0; i < emotion_list.length; i++) {
			current_emotion_index = i;
			status_msg = `retake: ${emotion_list[i]}`;
			await countdown_and_capture(emotion_list[i], selected_day);
		}
		session_running = false;
		status_msg = 'all retaken';
	}

	async function change_day(day: string) {
		selected_day = day;
		await load_day_photos(day);
	}

	// ===== initial effect (mount) =====
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
				selected_day = today_str();
				await load_day_photos(selected_day);
			}
			try {
				await start_stream();
			} catch {}
		})();
		return () => {
			active = false;
			media_stream?.getTracks().forEach((t) => t.stop());
			revoke_day_urls();
		};
	});
</script>

<div class="device">
	<h1>The booth</h1>
	<div>
		<button on:click={pick_root} disabled={!!root_handle}
			>{root_handle ? 'root picked' : 'pick root folder'}</button
		>
		{#if root_handle}<span> root: {(root_handle as any).name}</span>{/if}
	</div>
	<div>
		<label
			>camera:
			<select bind:value={selected_device_id} on:change={start_stream} disabled={session_running}>
				{#each video_devices as d}
					<option value={d.deviceId}>{d.label || 'camera'}</option>
				{/each}
			</select>
		</label>
		<button on:click={start_stream} disabled={session_running}>start camera</button>
	</div>

	<video bind:this={video_el} autoplay playsinline></video>
	{#if countdown_value > 0}
		<div>
			<h2 class="countdown">{countdown_value}</h2>
			{#if current_emotion}<p>pose: {current_emotion}</p>{/if}
		</div>
	{/if}
	{#if flash_active}
		<div>FLASH</div>
	{/if}

	<div>
		<button on:click={run_session} disabled={session_running || !root_handle}
			>capture all emotions (today)</button
		>
		<button on:click={retake_all_for_day} disabled={session_running || !selected_day}
			>retake all for selected day</button
		>
	</div>

	<div class="feed">
		<select
			bind:value={selected_day}
			on:change={(e) => change_day((e.target as HTMLSelectElement).value)}
		>
			{#each day_list as d}
				<option value={d}>{d}</option>
			{/each}
		</select>
		{#if selected_day}
			<ul>
				{#each emotion_list as emo, i}
					<li>
						<span>{emo}</span>
						{#if day_photos[emo]}
							<img alt={emo} src={day_photos[emo].url} />
							<button disabled={session_running} on:click={() => retake_one(emo)}>retake</button>
						{:else}
							<span>missing</span>
							<button disabled={session_running || !media_stream} on:click={() => retake_one(emo)}
								>capture</button
							>
						{/if}
						{#if session_running && current_emotion_index === i}<span> (capturing...)</span>{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>

	<div class="status">
		<p>status: {status_msg}</p>
	</div>
</div>

<style>
	h1 {
		text-transform: uppercase;
		font-weight: 400;
		font-size: 16px;
		text-align: center;
	}
	video {
		box-shadow: var(--shadow-screen);
		background: var(--black);
		margin: 1rem auto;
		display: block;
	}
	.device {
		background: var(--bg);
		padding: 20px;
		margin: 1rem;
		border-radius: 2px;
		box-shadow: var(--shadow-body);
	}

	.feed {
		ul {
			display: grid;
			grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
			padding: 0;
			list-style: none;
			background: var(--black);
			box-shadow: var(--shadow-screen);
			img {
				width: 100%;
			}
			li {
				color: var(--bg);
				position: relative;
				display: block;
				margin: 0;
				overflow: hidden;
				span {
					background: var(--black);
					position: absolute;
					text-transform: uppercase;
					display: block;
					font-size: 12px;
					inset-inline: 0;
					padding: 2px 5px;
				}
				button {
					position: absolute;
				}
			}
		}
	}
	.countdown {
		font-family: 'Calculator';
	}
	.status {
		box-shadow: var(--shadow-screen);
		background: var(--black);
		color: white;
		padding: 10px 20px;
	}
</style>
