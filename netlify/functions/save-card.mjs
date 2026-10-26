// Netlify Function: creates a Stripe Checkout page (setup mode) so a client can
// save a card or bank account WITHOUT being charged.
// Serves at /.netlify/functions/save-card
// Requires the environment variable STRIPE_SECRET_KEY (set in Netlify, scope: Functions).
// Uses Stripe's REST API directly, so no npm packages are needed.

const STRIPE_API = "https://api.stripe.com/v1";

async function stripe(path, params, key) {
  const res = await fetch(STRIPE_API + path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe error ${res.status}`);
    err.stripe = data?.error;
    throw err;
  }
  return data;
}

const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);

export default async (req) => {
  if (req.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const key = Netlify.env.get("STRIPE_SECRET_KEY");
  if (!key) {
    return Response.json({ error: "Card saving is not set up yet. Please call (404) 475-9765." }, { status: 500 });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const name = clean(body.name, 120);
  const email = clean(body.email, 200);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json({ error: "A name and valid email are required." }, { status: 400 });
  }

  const origin = new URL(req.url).origin;
  const meta = {
    property_address: clean(body.property_address),
    county: clean(body.county, 80),
    state: clean(body.state, 40),
    parcel_id: clean(body.parcel_id, 80),
    property_type: clean(body.property_type, 60),
    tax_years: clean(body.tax_years, 60),
    entity_name: clean(body.entity_name, 120),
    agreement_version: clean(body.agreement_version, 60),
    signed_at: clean(body.signed_at, 40),
  };

  try {
    // 1. Create the Stripe customer record (shows up under Customers in your dashboard).
    const customerParams = { name, email, description: `PTR client: ${meta.property_address}`.slice(0, 350) };
    const phone = clean(body.phone, 30);
    if (phone) customerParams.phone = phone;
    for (const [k, v] of Object.entries(meta)) if (v) customerParams[`metadata[${k}]`] = v;
    const customer = await stripe("/customers", customerParams, key);

    // 2. Create a Checkout page in "setup" mode: saves the payment method, charges nothing.
    const base = {
      mode: "setup",
      currency: "usd",
      customer: customer.id,
      success_url: `${origin}/?card=saved#signup`,
      cancel_url: `${origin}/?card=cancel#signup`,
      "custom_text[submit][message]":
        "Nothing is charged today. Per your agreement, your saved method is used only after your reduced value is final and you receive an invoice.",
      "setup_intent_data[metadata][property_address]": meta.property_address,
      "setup_intent_data[metadata][purpose]": "PTR contingency fee on file",
    };

    let session;
    try {
      // Offer card AND bank account (ACH is far cheaper for you).
      session = await stripe(
        "/checkout/sessions",
        { ...base, "payment_method_types[0]": "card", "payment_method_types[1]": "us_bank_account" },
        key
      );
    } catch (e) {
      // If bank payments aren't enabled on the Stripe account yet, fall back to card only.
      session = await stripe("/checkout/sessions", { ...base, "payment_method_types[0]": "card" }, key);
    }

    return Response.json({ url: session.url });
  } catch (e) {
    console.error("save-card error:", e.message, e.stripe?.type || "");
    return Response.json(
      { error: "We couldn't open the secure card page right now. Please call or text (404) 475-9765." },
      { status: 502 }
    );
  }
};
