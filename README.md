# n8n-nodes-salesforce-session

An n8n community node that logs in to Salesforce **once** with the SOAP `login()` call and then
reuses the resulting session ID for every REST API request — the same way a browser piggybacks on
its `sid` cookie.

- [Why this node exists](#why-this-node-exists)
- [How the session is piggybacked](#how-the-session-is-piggybacked)
- [Requirements](#requirements)
- [Installing on a self-hosted n8n](#installing-on-a-self-hosted-n8n)
  - [Method 1: GUI install from npm](#method-1-gui-install-from-npm)
  - [Method 2: Manual install into `~/.n8n/nodes`](#method-2-manual-install-into-n8nnodes)
  - [Method 3: Docker](#method-3-docker)
  - [Method 4: Docker Compose with a persistent volume](#method-4-docker-compose-with-a-persistent-volume)
  - [Method 5: Bake into a custom image](#method-5-bake-into-a-custom-image)
  - [Method 6: Environment variables (n8n 2.21+)](#method-6-environment-variables-n8n-221)
  - [Method 7: Private node without publishing](#method-7-private-node-without-publishing)
  - [Queue mode and multiple workers](#queue-mode-and-multiple-workers)
  - [Verifying the install](#verifying-the-install)
  - [Upgrading and uninstalling](#upgrading-and-uninstalling)
  - [Troubleshooting the install](#troubleshooting-the-install)
- [Credential: Salesforce Session API](#credential-salesforce-session-api)
- [Node: Salesforce Session](#node-salesforce-session)
- [Workflow examples](#workflow-examples)
- [Publishing to npm](#publishing-to-npm)
- [Development](#development)
- [Notes and limits](#notes-and-limits)
- [License](#license)

## Why this node exists

The built-in Salesforce nodes use OAuth2, which needs a Connected App, a callback URL and a browser
consent flow. If you already have a username, password and security token, this node gets you a
session in one request and keeps it warm:

- The session ID is stored **on the credential** (encrypted at rest by n8n), not in the workflow.
- It is refreshed automatically when it is missing or when Salesforce answers `401`.
- Every request reuses the cached session, so you pay for one login instead of one per item.

## How the session is piggybacked

n8n only persists data from a credential's `preAuthentication` hook when the credential declares a
hidden property with `typeOptions.expirable: true`. This package declares `sessionId` that way, so:

1. `preAuthentication` runs a SOAP `login()` and returns `{ sessionId, instanceUrl, serverUrl }`.
2. n8n writes those values back onto the credential.
3. `authenticate` attaches the stored session to each request as `Cookie: sid=…`,
   `Authorization: Bearer …`, or both.
4. On a `401`, n8n re-runs `preAuthentication` and retries the request once with a fresh session.

Because the session lives on the credential, it survives workflow edits and is shared by every node
in the instance that uses the same credential.

## Requirements

| Requirement | Notes |
| --- | --- |
| n8n | Self-hosted. Unverified community nodes are not available on n8n Cloud. |
| n8n version | Built against `n8n-workflow` 2.x. Use n8n 2.x or newer. |
| Node.js | 20 or newer (whatever your n8n release requires). |
| Salesforce | A user with API access, plus the security token unless your IP is trusted. |

Community packages must be enabled. This is the default, but check it if the node never appears:

```bash
N8N_COMMUNITY_PACKAGES_ENABLED=true
```

## Installing on a self-hosted n8n

Pick the method that matches how your instance runs. All of them end with a **restart**, because
n8n scans for nodes at startup.

### Method 1: GUI install from npm

Works when n8n can reach the npm registry and you are the instance owner or an admin.

1. The package must be on npm. See [Publishing to npm](#publishing-to-npm), or
   [Method 7](#method-7-private-node-without-publishing) if you do not want to publish.
2. In n8n, go to **Settings → Community Nodes → Install**.
3. Enter the package name, optionally with a version: `n8n-nodes-salesforce-session` or
   `n8n-nodes-salesforce-session@0.1.0`.
4. Accept the unverified-code warning and select **Install**.
5. Restart n8n if the node does not appear immediately.

The GUI writes into `~/.n8n/nodes` for you, so this is equivalent to Method 2.

### Method 2: Manual install into `~/.n8n/nodes`

Use this when the GUI is unavailable, when you run queue mode, or when you install a private
package.

```bash
# On the host, or inside the container (see Method 3)
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install n8n-nodes-salesforce-session
```

Then restart n8n:

```bash
# systemd
sudo systemctl restart n8n

# pm2
pm2 restart n8n

# plain process: stop it and start it again
```

If you run n8n as a different user, install into **that** user's home. `~/.n8n` resolves from the
process owner, not from your shell.

To use a different data folder, point `N8N_USER_FOLDER` at it and install into
`$N8N_USER_FOLDER/nodes` instead.

### Method 3: Docker

The container's `~/.n8n` is `/home/node/.n8n` for the official image. Install into the running
container, then restart it:

```bash
docker exec -it n8n sh -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install n8n-nodes-salesforce-session"
docker restart n8n
```

This only survives as long as the container does. If you recreate the container, repeat the
install — or use Method 4 or 5 so it persists.

### Method 4: Docker Compose with a persistent volume

Mount a named volume (or a host directory) at `/home/node/.n8n` so installed packages survive
container recreation.

```yaml
services:
  n8n:
    image: docker.n8n.io/n8nio/n8n:latest
    container_name: n8n
    ports:
      - "5678:5678"
    environment:
      - N8N_COMMUNITY_PACKAGES_ENABLED=true
      - GENERIC_TIMEZONE=Europe/London
    volumes:
      - n8n_data:/home/node/.n8n

volumes:
  n8n_data:
```

Start it once, install the package into the volume, then restart:

```bash
docker compose up -d
docker compose exec n8n sh -c "mkdir -p /home/node/.n8n/nodes && cd /home/node/.n8n/nodes && npm install n8n-nodes-salesforce-session"
docker compose restart n8n
```

Because `n8n_data` persists, the package stays installed across `docker compose down` / `up`.

### Method 5: Bake into a custom image

Best for immutable deployments and CI. The package is present from the first boot, so no manual
step is needed.

```dockerfile
FROM docker.n8n.io/n8nio/n8n:latest

USER root
RUN mkdir -p /home/node/.n8n/nodes \
 && cd /home/node/.n8n/nodes \
 && npm install --omit=dev n8n-nodes-salesforce-session
USER node
```

```bash
docker build -t my-n8n:latest .
docker run -d --name n8n -p 5678:5678 -v n8n_data:/home/node/.n8n my-n8n:latest
```

Keep the volume mount: it holds the database, the encryption key and your credentials. Only the
node package is baked into the image.

### Method 6: Environment variables (n8n 2.21+)

n8n can reconcile a fixed list of community packages on every startup. This is the cleanest option
for a deployment pipeline.

```yaml
environment:
  - N8N_COMMUNITY_PACKAGES_ENABLED=true
  - N8N_COMMUNITY_PACKAGES_MANAGED_BY_ENV=true
  - N8N_COMMUNITY_PACKAGES=[{"name":"n8n-nodes-salesforce-session","version":"0.1.0"}]
```

> **Warning:** the first start with `N8N_COMMUNITY_PACKAGES_MANAGED_BY_ENV=true` **uninstalls every
> community package that is not in the list**. Add your existing packages to
> `N8N_COMMUNITY_PACKAGES` before enabling it. While it is enabled, the Community Nodes settings
> page becomes read-only.

If the package is not in n8n's vetted registry and `N8N_UNVERIFIED_PACKAGES_ENABLED=false`, n8n
refuses to start unless you pin a `checksum`. Either leave unverified packages enabled or supply
the SHA-512 of the tarball:

```json
[{ "name": "n8n-nodes-salesforce-session", "version": "0.1.0", "checksum": "sha512-..." }]
```

### Method 7: Private node without publishing

You can run this package without putting it on npm. Build it, then copy the compiled folders into
n8n's custom directory.

```bash
git clone <this repo> n8n-nodes-salesforce-session
cd n8n-nodes-salesforce-session
npm install
npm run build
```

The build output is self-contained: `dist/nodes` and `dist/credentials` have no dependency on any
other folder in the package, so copying just those two is enough.

```bash
mkdir -p ~/.n8n/custom
cp -r dist/nodes dist/credentials ~/.n8n/custom/
```

Restart n8n. For Docker, copy into the container instead:

```bash
docker cp dist/nodes n8n:/home/node/.n8n/custom/
docker cp dist/credentials n8n:/home/node/.n8n/custom/
docker restart n8n
```

To keep the source outside `~/.n8n`, point `N8N_CUSTOM_EXTENSIONS` at the directory that contains
`nodes/` and `credentials/`:

```bash
N8N_CUSTOM_EXTENSIONS=/opt/n8n-custom
```

`n8n-workflow` is provided by n8n at runtime, so you do not need to copy `node_modules`.

### Queue mode and multiple workers

In queue mode the **main** instance serves the editor and the **workers** execute workflows. Both
need the package:

- Install it on every instance that loads nodes — main and each worker.
- With Docker, bake it into the image (Method 5) or mount the same volume into every container.
- With Method 6, set the same `N8N_COMMUNITY_PACKAGES` value on every container.
- Restart workers after installing; they load nodes at startup.

Credentials are stored in the shared database, so a session created by one worker is visible to the
others. The encryption key must be identical across instances, which is already required for queue
mode.

### Verifying the install

1. Restart n8n and reload the editor.
2. Open the nodes panel with <kbd>Tab</kbd> or the **+** button.
3. Search for **Salesforce Session**. It appears under the **Custom Nodes** category.
4. Create a credential of type **Salesforce Session API** and click **Test**.

If the node is missing, check the startup log for lines mentioning the package name, and confirm
`N8N_COMMUNITY_PACKAGES_ENABLED` is not `false`.

### Upgrading and uninstalling

```bash
# Upgrade to latest
cd ~/.n8n/nodes && npm update n8n-nodes-salesforce-session

# Pin a specific version
cd ~/.n8n/nodes && npm install n8n-nodes-salesforce-session@0.2.0

# Uninstall
cd ~/.n8n/nodes && npm uninstall n8n-nodes-salesforce-session
```

Restart n8n after any of these. In the GUI, use **Settings → Community Nodes** and the
**Update** / **Uninstall package** actions instead.

Upgrading does not invalidate stored credentials, but a stored session may belong to an older
login. If requests start failing after an upgrade, open the credential and click **Test** to force
a fresh login.

### Troubleshooting the install

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Node never appears | Community packages disabled | Set `N8N_COMMUNITY_PACKAGES_ENABLED=true` and restart |
| Node never appears | Installed into the wrong home | Install into the n8n process owner's `~/.n8n/nodes` |
| Node disappears after `docker compose down` | No volume on `/home/node/.n8n` | Add the volume (Method 4) or bake the image (Method 5) |
| `Cannot find module 'n8n-workflow'` | Copied `dist` without n8n's runtime | Use Method 2/5, or copy into `~/.n8n/custom` (Method 7) |
| `Cannot find module '../../shared/session'` | Stale build from an older layout | Rebuild with `npm run build` |
| Install fails behind a proxy | npm cannot reach the registry | Set `HTTP_PROXY`/`HTTPS_PROXY`, or use `N8N_COMMUNITY_PACKAGES_REGISTRY` |
| n8n will not start after install | Faulty package | Set `N8N_COMMUNITY_PACKAGES_PREVENT_LOADING=true` to boot, then remove the package |
| Credential test fails with `INVALID_LOGIN` | Wrong password/token, or IP not trusted | Regenerate the security token, or allow the host IP in Salesforce |

## Credential: Salesforce Session API

| Field | Notes |
| --- | --- |
| Login URL | Production, Sandbox, or a custom My Domain host |
| API Version | Used for both the SOAP login and the REST base path (default `62.0`) |
| Username | Salesforce username |
| Password | Salesforce password |
| Security Token | Appended to the password; leave empty if your IP is trusted |
| Send Session As | `Cookie (sid)`, `Bearer Token`, or `Both` |
| Options | Request timeout, ignore SSL issues |

Click **Test** to verify. The test performs a real login and then calls the REST API root, so a
successful test also proves the session works.

**Which "Send Session As" should I pick?**

- `Cookie (sid)` — closest to a browser session. Use it when you want the same behaviour as a
  logged-in UI session.
- `Bearer Token` — the documented form for the REST API. Use it if you hit any endpoint that rejects the
  cookie.
- `Both` — sends both headers. Useful as a fallback while diagnosing a `401`.

## Node: Salesforce Session

### Operation: Request

| Field | Notes |
| --- | --- |
| Method | `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD` |
| Endpoint | Path relative to `/services/data/v{version}/`, e.g. `sobjects/Account`. A full URL is used as-is. |
| Query Parameters | JSON object appended as a query string |
| Body | JSON body for `POST`/`PUT`/`PATCH`/`DELETE` |
| Headers | Extra headers merged into the request |
| Options | Full response, ignore SSL issues, never error, timeout |

Endpoint resolution:

| Endpoint value | Resulting URL |
| --- | --- |
| `sobjects/Account` | `{instanceUrl}/services/data/v62.0/sobjects/Account` |
| `/sobjects/Account` | `{instanceUrl}/services/data/v62.0/sobjects/Account` |
| `services/data/v61.0/limits` | `{instanceUrl}/services/data/v61.0/limits` |
| *(empty)* | `{instanceUrl}/services/data/v62.0/` |
| `https://other.example.com/x` | `https://other.example.com/x` |

### Operation: Get Session

Returns the current session so other nodes or tools can reuse it:

```json
{
  "sessionId": "00D...!AQ4AQ...",
  "instanceUrl": "https://na123.salesforce.com",
  "apiVersion": "62.0",
  "authMode": "cookie",
  "authorizationHeader": "Bearer 00D...!AQ4AQ...",
  "cookieHeader": "sid=00D...!AQ4AQ..."
}
```

Feed `instanceUrl` into an HTTP Request node and set the `Cookie` or `Authorization` header from the
values above when you need a node this package does not cover.

## Workflow examples

**Query accounts**

1. **Salesforce Session** → Operation `Request`, Method `GET`, Endpoint `query`,
   Query Parameters `{ "q": "SELECT Id, Name FROM Account LIMIT 10" }`.
2. The response is the standard `{ totalSize, done, records: [...] }` envelope.

**Create a record**

1. **Salesforce Session** → Operation `Request`, Method `POST`, Endpoint `sobjects/Account`,
   Body `{ "Name": "Acme" }`.
2. The response contains `id`, `success` and `errors`.

**Reuse the session in an HTTP Request node**

1. **Salesforce Session** → Operation `Get Session`.
2. **HTTP Request** → URL `{{ $json.instanceUrl }}/services/data/v{{ $json.apiVersion }}/limits`,
   send header `Cookie` = `{{ $json.cookieHeader }}`.

## Publishing to npm

The package is published to npm by GitHub Actions, not from a local machine. This is required for
npm provenance, which n8n needs to consider the node for verified status.

### One-time setup

1. **Create a Granular Access Token on npmjs.com**

   Access Tokens → Generate New Token → Granular Access Token. Give it:
   - **Packages and scopes:** Read and write
   - **Packages:** `n8n-nodes-salesforce-session` (or all packages, if it does not exist yet)
   - **Bypass two-factor authentication:** ✅ **must be checked**
   - **Expiration:** 90 days or less

   The bypass checkbox is not optional. Without it, CI publishing fails with:

   ```
   npm error 403 Two-factor authentication or granular access token with
   bypass 2fa enabled is required to publish packages.
   ```

   npm requires an interactive 2FA challenge for publishes unless the token
   explicitly opts out. A CI runner has no way to answer that challenge.

2. **Add it as a repository secret**

   ```bash
   gh secret set NPM_TOKEN --repo supanmaniar/n8n-nodes-salesforce-session
   ```

   Paste the token when prompted. Never commit it.

3. **After the first publish, switch to Trusted Publishing (recommended)**

   Bypass-2FA tokens are being deprecated for direct publishing in January 2027, so treat the token
   as a bootstrap step only.

   If the token was created with **Read and write (stage only)** instead of **Read and write**, npm
   stages each release rather than publishing it. The workflow then fails with:

   ```
   npm error 409 Conflict - Cannot publish over previously staged version "x.y.z"
   ```

   Promote the staged version by hand:

   ```bash
   npm stage list
   npm stage approve <stage-id> --otp <code>
   ```

   Or recreate the token with plain **Read and write** access to publish directly.

   On npmjs.com → your package → **Settings → Publish access → Trusted Publishers → Add a
   publisher** → GitHub Actions, with repository owner `supanmaniar`, repository
   `n8n-nodes-salesforce-session`, workflow `publish.yml`. Then delete the `NPM_TOKEN` secret; the
   workflow falls back to GitHub's OIDC token automatically.

   Trusted Publishing can only be configured **after** the package exists on npm, which is why the
   first release uses a token.

### Releasing a new version

```bash
npm run release
```

This runs `release-it`, which lints, builds, prompts for a version bump, updates the changelog,
commits, tags, and pushes. The tag push triggers `.github/workflows/publish.yml`, which publishes
to npm with a provenance attestation.

Do **not** run `npm publish` directly. The `prepublishOnly` hook blocks it unless `RELEASE_MODE` is
set, and a local publish produces no provenance.

### Verifying the publish

```bash
npm view n8n-nodes-salesforce-session version
npm audit signatures
```

The package page on npmjs.com shows a **Provenance** badge once the attestation is attached.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run typecheck  # tsc --noEmit
npm run lint       # n8n community-node lint rules
npm test           # offline tests: SOAP parsing, credential lifecycle, node execute
npm run dev        # run n8n with this package loaded
```

The tests in `scripts/` need no network access:

- `smoke-test.js` — SOAP envelope building, fault/session parsing, header modes.
- `lifecycle-test.js` — simulates n8n's `preAuthentication` → persist → `authenticate` → `401`
  retry loop against the built credential.
- `node-test.js` — drives `execute()` with mocked helpers for both operations.

## Notes and limits

- The SOAP `login()` call is subject to org login policies: IP ranges, login hours, and
  "high assurance" sessions can all reject it. Use a My Domain login host if your org requires it.
- Session IDs inherit the permissions of the authenticating user. Use a dedicated integration user.
- Sessions are invalidated by password changes, admin session revocation, or org maintenance; the
  next `401` triggers a fresh login automatically.
- This package does not implement OAuth2. If you need per-user consent or refresh tokens, use the
  official Salesforce nodes.

## License

MIT
