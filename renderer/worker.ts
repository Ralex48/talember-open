import { Container, getContainer } from '@cloudflare/containers';
export class GreetingRenderer extends Container {
  defaultPort = 8080;
  sleepAfter = '30s';
  enableInternet = false;
}
export default {
  async fetch(request: Request, env: { RENDERER: DurableObjectNamespace<GreetingRenderer> }) {
    if (request.method !== 'POST' || !['/render','/preview'].includes(new URL(request.url).pathname)) return new Response(null, { status: 404 });
    const container = getContainer(env.RENDERER, 'greeting-v2');
    const health = await container.fetch(new Request('https://renderer/health'));
    await health.body?.cancel();
    if (health.status === 501 || health.status === 404 || (health.ok && health.headers.get('X-Renderer-Version') !== 'placement-1')) {
      await container.destroy();
      return new Response(null,{status:503});
    }
    if (!health.ok) return new Response(null,{status:503});
    const response = await container.fetch(request);
    if ((response.ok && response.headers.get('X-Renderer-Version') !== 'placement-1') || response.status === 404) {
      await response.body?.cancel();
      await container.destroy();
      return new Response(null, { status: 503 });
    }
    return response;
  },
};
