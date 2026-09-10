# Deploy an instance

Use your own Cloudflare account, domain, PayPal merchant account and creative
provider accounts. Creation is disabled in the sample configuration.

1. Install Node24, run `npm ci`, and authenticate Wrangler in your private
   environment. Review permissions before granting access.
2. Create a D1 database and private R2 bucket with `wrangler d1 create` and
   `wrangler r2 bucket create`. Set their identifiers in wrangler.jsonc and set
   your account through CLOUDFLARE_ACCOUNT_ID. The checked-in database UUID is a
   placeholder. Do not commit your private deployment configuration.
3. For a **new empty database**, review the included migrations, then apply them
   with `wrangler d1 migrations apply TALEMBER_DB --remote`. Back up and inspect
   an existing database before applying only its missing compatible migrations.
4. Deploy renderer/wrangler.jsonc to Cloudflare Containers. The paid Workers plan,
   Containers access and Docker build/push support are needed. The renderer uses a
   private service binding, with no public hostname. Runtime costs are separate.
5. Configure Worker secrets for the selected providers. Inspect ServiceEnv in
   app/types.ts for the complete names. Typical names include OPENROUTER_API_KEY,
   FAL_API_KEY, PAYPAL_SANDBOX_CLIENT_ID and PAYPAL_SANDBOX_CLIENT_SECRET. Live
   PayPal also needs its separate client ID, secret and merchant ID. Never put
   values in source, issue text, shell arguments or public CI logs.
6. Set your support contact, business identity, public origin and provider/model
   configuration. Review policy text in app/release-copy.ts. Verify model access
   and image/video input compatibility with your provider account.
7. Build the browser bundle and deploy the Worker. Configure a custom domain
   through Cloudflare, preserving unrelated DNS and email records.
8. Set TALEMBER_OVERLAY_ENABLED=true only with the working renderer binding.
   Validate synthetic rendering and a bounded authorized end-to-end trial before
   enabling creation. PayPal sandbox does not make creative provider calls free.

No public workflow deploys the application. For production, keep deployment
configuration and credentials in a separate private repository/environment.
Deploy compatible renderer and Worker versions together. Migrations are a
separate reviewed operation, not an automatic release side effect.

For RHEL, follow ops/README.md. Ansible defaults leave the existing runner and
system packages alone and install only the Go probe. Enable additional tasks
explicitly on a lab host before adopting them for production.

The app retains a saved raw video for finishing retries and placement changes;
it does not buy another generation when compositing fails. Review the current
retention behavior in app/jobs.ts. An AI video can still contain physical or
identity errors despite a valid script. Public-page monitoring cannot establish
successful checkout, provider completion or correct final media.
