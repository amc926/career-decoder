// Serverless proxy between career-decoder.html and the Anthropic API.
// The API key stays here as a Netlify environment variable and is never sent to browsers.

export const config = { path: "/api/claude" };

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";
const MAX_TOKENS_CAP = 4000;   // hard ceiling regardless of what the page asks for
const MAX_INPUT_CHARS = 8000;  // rough guard on prompt size

// Best-effort in-memory rate limiting. Resets on cold start and is per-instance,
// so it deters casual abuse rather than being a hard guarantee.
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_REQ_PER_WINDOW = 15;
const hits = new Map(); // ip -> number[] (timestamps)

function rateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_REQ_PER_WINDOW;
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({ error: "Server is missing ANTHROPIC_API_KEY" }, 500);
  }

  const ip =
    context?.ip ||
    req.headers.get("x-nf-client-connection-ip") ||
    req.headers.get("x-forwarded-for") ||
    "unknown";
  if (rateLimited(ip)) {
    return json({ error: "Rate limit exceeded. Try again in a few minutes." }, 429);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { system, messages, max_tokens } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: "Missing 'messages'" }, 400);
  }

  const totalChars =
    (typeof system === "string" ? system.length : 0) +
    JSON.stringify(messages).length;
  if (totalChars > MAX_INPUT_CHARS) {
    return json({ error: "Request too large" }, 413);
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: Math.min(Number(max_tokens) || 2000, MAX_TOKENS_CAP),
      system: typeof system === "string" ? system : undefined,
      messages,
    }),
  });

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { "content-type": "application/json" },
  });
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });
}
