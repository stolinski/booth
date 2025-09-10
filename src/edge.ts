// Wrapper Worker to add COOP/COEP headers to every response
// Ensures module worker and static assets inherit required isolation headers
import worker from '../.svelte-kit/cloudflare/_worker.js';

export default {
	async fetch(request: Request, env: unknown, ctx: unknown): Promise<Response> {
		const response: Response = await (worker as any).fetch(request, env, ctx);
		// Clone headers to avoid immutable header guard
		const headers = new Headers(response.headers);
		headers.set('Cross-Origin-Opener-Policy', 'same-origin');
		headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers
		});
	}
};
