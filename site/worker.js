// Static-asset server for the site with one rule: anything served from a
// workers.dev host is staging and must not be indexed. The production custom
// domain gets no such header, so search engines only ever see one canonical
// site. No other logic lives here on purpose.
export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    const host = new URL(request.url).hostname;
    if (!host.endsWith(".workers.dev")) return res;
    const headers = new Headers(res.headers);
    headers.set("X-Robots-Tag", "noindex");
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  },
};
