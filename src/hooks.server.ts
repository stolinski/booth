import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';

// Apply COOP/COEP only when not in dev to avoid blocking cross-origin dev assets
export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event, {
		filterSerializedResponseHeaders: (name) => name === 'content-type'
	});
	if (!dev) {
		response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
		response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
	}
	return response;
};
