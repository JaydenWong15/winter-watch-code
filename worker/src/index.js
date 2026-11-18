// Cloudflare Worker key proxy (TAPI template, Anthropic Messages API).
// The page calls this Worker; the Worker holds the API key as the Cloudflare secret ANTHROPIC_API_KEY.
// The key is never in this file or on GitHub.
//
// Safeguards: origin lock (CORS), one endpoint, model allowlist, max_tokens cap, effort allowlist,
// tools stripped, body size limit, per-visitor hourly rate limit in KV (binding RATE).
// The real money cap is the spend limit on the provider workspace that owns the key.

// ===== CONFIG: fill these in for the project =====
const ALLOWED_ORIGIN = "https://jaydenwong15.github.io";            // exact page origin, no trailing slash
const ALLOWED_MODELS = ["claude-haiku-5-5"];                 // what the page uses
const MAX_TOKENS = 16000;
const MAX_BODY_BYTES = 200_000;
const HOURLY_LIMIT = 20;                                     // requests per visitor (IP) per clock hour
const ALLOWED_EFFORT = ["low", "medium"];
const UPSTREAM = "https://api.anthropic.com/v1/messages";
// ==================================================

function cors(origin) {
  return {
    "Access-Control-Allow-Origin": origin === ALLOWED_ORIGIN ? ALLOWED_ORIGIN : "null",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Expose-Headers": "x-proxy-remaining",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
}

function error(status, message, origin, extra = {}) {
  return new Response(JSON.stringify({ error: { type: "proxy_error", message } }), {
    status,
    headers: { "content-type": "application/json", ...cors(origin), ...extra }
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
    if (origin !== ALLOWED_ORIGIN) return error(403, "This service only answers its own page.", origin);
    if (request.method !== "POST" || url.pathname !== "/v1/messages") return error(404, "Not found.", origin);
    if (!env.ANTHROPIC_API_KEY) return error(503, "The shared key has not been set up yet. Use your own key in Settings.", origin);

    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return error(413, "Request too large.", origin);
    let body;
    try { body = JSON.parse(raw); } catch (e) { return error(400, "Invalid JSON.", origin); }
    if (!ALLOWED_MODELS.includes(body.model)) return error(400, `Only ${ALLOWED_MODELS.join(", ")} allowed through the shared key.`, origin);
    if (!Array.isArray(body.messages) || body.messages.length === 0) return error(400, "No messages.", origin);
    const effort = body.output_config && body.output_config.effort;
    if (effort && !ALLOWED_EFFORT.includes(effort)) return error(400, `Effort must be ${ALLOWED_EFFORT.join(" or ")}.`, origin);

    // Per-visitor hourly limit
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const hour = Math.floor(Date.now() / 3_600_000);
    const rlKey = `rl:${ip}:${hour}`;
    const used = parseInt((await env.RATE.get(rlKey)) || "0", 10);
    if (used >= HOURLY_LIMIT) {
      return error(429, `Hourly limit reached (${HOURLY_LIMIT} requests per visitor per hour). Try again later, or use your own API key.`, origin, { "x-proxy-remaining": "0" });
    }
    await env.RATE.put(rlKey, String(used + 1), { expirationTtl: 7200 });

    // Forward only known-safe fields
    const forward = {
      model: body.model,
      max_tokens: Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS),
      system: body.system,
      messages: body.messages
    };
    if (body.stream === true) forward.stream = true;
    if (body.output_config) {
      forward.output_config = {};
      if (effort) forward.output_config.effort = effort;
      if (body.output_config.format) forward.output_config.format = body.output_config.format;
    }

    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(forward)
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") || "application/json",
        "x-proxy-remaining": String(HOURLY_LIMIT - used - 1),
        ...cors(origin)
      }
    });
  }
};
