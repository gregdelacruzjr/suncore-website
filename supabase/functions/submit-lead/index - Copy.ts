// Supabase Edge Function: submit-lead
// Verifies a Cloudflare Turnstile token, then inserts the lead using the
// service role key. This is the only way leads should reach the table —
// the public "leads for insert to anon" RLS policy should be dropped once
// this is deployed (see accompanying SQL).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY")!;

// Tighten this to your real domain once deployed, e.g. "https://your-site.netlify.app"
const ALLOWED_ORIGIN = "*";

const corsHeaders = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REQUIRED_FIELDS = [
  "full_name",
  "email",
  "address",
  "building_type",
  "kwh_monthly",
  "preferred_setup",
];

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const body = await req.json();
    const { turnstileToken, ...lead } = body;

    if (!turnstileToken) {
      return new Response(
        JSON.stringify({ error: "Missing verification token." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 1. Verify the human-check token with Cloudflare
    const verifyRes = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: TURNSTILE_SECRET_KEY,
          response: turnstileToken,
        }),
      },
    );
    const verifyData = await verifyRes.json();

    if (!verifyData.success) {
      return new Response(
        JSON.stringify({ error: "Verification failed. Please try again." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Validate required fields server-side (never trust the client)
    for (const field of REQUIRED_FIELDS) {
      if (lead[field] === undefined || lead[field] === null || lead[field] === "") {
        return new Response(
          JSON.stringify({ error: `Missing required field: ${field}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    const kwh = Number(lead.kwh_monthly);
    if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 100000) {
      return new Response(
        JSON.stringify({ error: "kwh_monthly is out of range." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 3. Insert using the service role key — bypasses RLS, safe because this
    //    code only runs on the server and the key never reaches the browser.
    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/leads`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        Prefer: "return=minimum",
      },
      body: JSON.stringify({
        full_name: String(lead.full_name).slice(0, 200),
        email: String(lead.email).slice(0, 200),
        address: String(lead.address).slice(0, 300),
        building_type: String(lead.building_type).slice(0, 50),
        kwh_monthly: kwh,
        preferred_setup: String(lead.preferred_setup).slice(0, 50),
        message: lead.message ? String(lead.message).slice(0, 1000) : null,
      }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return new Response(JSON.stringify({ error: errText }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
