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

// Fields required for every lead, regardless of inquiry type
const COMMON_REQUIRED_FIELDS = ["full_name", "email", "address", "phone_number"];

// Additional fields required per inquiry_type
const REQUIRED_FIELDS_BY_TYPE: Record<string, string[]> = {
  solar: ["building_type", "kwh_monthly", "preferred_setup"],
  software: ["category", "message"],
};

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

    // Default to "solar" for backward compatibility with older form submissions
    // that don't send inquiry_type at all.
    const inquiryType = lead.inquiry_type ? String(lead.inquiry_type) : "solar";
    const typeSpecificFields = REQUIRED_FIELDS_BY_TYPE[inquiryType];

    if (!typeSpecificFields) {
      return new Response(
        JSON.stringify({ error: `Unknown inquiry_type: ${inquiryType}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // 2. Validate required fields server-side (never trust the client)
    const requiredFields = [...COMMON_REQUIRED_FIELDS, ...typeSpecificFields];
    for (const field of requiredFields) {
      if (lead[field] === undefined || lead[field] === null || lead[field] === "") {
        return new Response(
          JSON.stringify({ error: `Missing required field: ${field}` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // kwh_monthly range check only applies to solar leads
    let kwh: number | null = null;
    if (inquiryType === "solar") {
      kwh = Number(lead.kwh_monthly);
      if (!Number.isFinite(kwh) || kwh <= 0 || kwh > 100000) {
        return new Response(
          JSON.stringify({ error: "kwh_monthly is out of range." }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }
    }

    // Validate PH mobile number format server-side (never trust the client)
    const phoneNumber = String(lead.phone_number);
    if (!/^09\d{9}$/.test(phoneNumber)) {
      return new Response(
        JSON.stringify({ error: "phone_number must be a valid PH mobile number." }),
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
        phone_number: phoneNumber.slice(0, 20),
        inquiry_type: inquiryType.slice(0, 50),
        building_type: lead.building_type ? String(lead.building_type).slice(0, 50) : null,
        kwh_monthly: kwh,
        preferred_setup: lead.preferred_setup ? String(lead.preferred_setup).slice(0, 50) : null,
        category: lead.category ? String(lead.category).slice(0, 50) : null,
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
