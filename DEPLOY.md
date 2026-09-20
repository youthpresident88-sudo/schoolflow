# Putting SchoolFlow online

You need a host that can run a Docker container (or Node 22.13+), give it a **persistent disk/volume**, and serve
HTTPS. SchoolFlow stores everything in one SQLite file, so without a persistent volume your data is lost on redeploy.

1. Put this folder in a GitHub repository.
2. On your host (Render, Railway, Fly.io, or any VPS), create a new **web service from the repository**. It will find
   the `Dockerfile`.
3. Attach a **volume/disk mounted at `/data`**.
4. Environment variables are already set in the Dockerfile. Add these when you have them:
   * `SF_BASE_DOMAIN` — e.g. `yourschoolflow.com`, for `school.yourschoolflow.com` sign-in pages
   * `SF_SMS_URL`, `SF_SMS_KEY` — your SMS gateway
5. Open the URL the host gives you. The first visitor can create a school account.

Notes
* The Dockerfile sets `SF_SECURE_COOKIES=1`, which needs HTTPS. Hosts provide this automatically. To run the container
  on plain http://localhost, remove that variable.
* Run **one** instance only (SQLite is a single-file database).
* Back up the `/data` volume regularly.
* I could not build the Docker image where this was written, so treat the first deploy as a test.
