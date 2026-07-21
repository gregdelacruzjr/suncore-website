# Deploying the submit-lead Edge Function

Run these on your own machine, in order.

## 1. Install the Supabase CLI
```bash
npm install -g supabase
```

## 2. Log in
```bash
supabase login
```
This opens a browser window to authenticate.

## 3. Link this project to your Supabase project
From inside the `pwa` folder (the one containing the `supabase/` directory):
```bash
supabase link --project-ref bomajvafxbwwyfjwtapn
```

## 4. Set your secrets
Two secrets are needed. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
already auto-injected by Supabase into every Edge Function — you only need
to set the Turnstile one yourself:

```bash
supabase secrets set TURNSTILE_SECRET_KEY=paste_your_turnstile_secret_key_here
```
(Get this from the Cloudflare Turnstile dashboard — Part 1 of the setup.)

## 5. Deploy
```bash
supabase functions deploy submit-lead --no-verify-jwt
```
`--no-verify-jwt` is required here because this function needs to be
callable by anonymous site visitors (no logged-in Supabase user), the same
way the direct table insert worked before.

## 6. Your function URL
Once deployed, it will be live at:
```
https://bomajvafxbwwyfjwtapn.supabase.co/functions/v1/submit-lead
```
This is already set in the updated `index.html`.

## 7. Close the direct-write hole
This is the step that actually fixes the vulnerability — run this in the
Supabase SQL Editor to remove the old policy that let anyone insert
directly into the table:

```sql
drop policy "Allow public lead submissions" on leads;
```

After this, the `leads` table only accepts writes from the Edge Function
(via the service role key, which bypasses RLS). Direct POSTs to the REST
API using the anon key will be rejected — even though the anon key is
still technically visible in your frontend code, it can no longer do
anything with the `leads` table at all.

## 8. Test it
Submit a real lead through your deployed site and confirm a row lands in
`leads`. Then try POSTing directly to the old REST endpoint (e.g. via
curl or Postman) with the anon key — it should now be rejected.
