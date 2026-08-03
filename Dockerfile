# Major version and distro are pinned; the patch level floats so rebuilds pick
# up Alpine security fixes instead of failing the image scan months later. Pin
# to a digest instead if byte-identical rebuilds matter more than staying
# patched.
FROM node:20-alpine3.21 AS deps

WORKDIR /app
# The trailing * makes the lockfile optional: COPY fails outright on a pattern
# that matches nothing, and a generated project may not have one yet.
COPY package.json package-lock.json* ./
# With a lockfile the install is reproducible; without one it still builds.
# If npm ci reports "package.json and package-lock.json are not in sync", run
# `npm install` locally and commit the refreshed lockfile.
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      echo "WARNING: no package-lock.json — installing from package.json"; \
      npm install --omit=dev --no-audit --no-fund; \
    fi \
    && npm cache clean --force

# The Amazon RDS certificate authority bundle. RDS presents a certificate from
# a private CA that is NOT in any system trust store, so without this bundle the
# only ways to connect are "no TLS" or "TLS without verification" — both of
# which send database credentials over a channel nobody has authenticated.
RUN wget -qO /rds-global-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
    && head -1 /rds-global-bundle.pem | grep -q "BEGIN CERTIFICATE"

FROM node:20-alpine3.21 AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_SSL_CA=/app/certs/rds-global-bundle.pem

WORKDIR /app

# Two things happen here, both driven by what the image scan gate actually
# finds on a stock Node image:
#
#  1. `apk upgrade` patches the OS packages the base image ships behind. Base
#     images trail Alpine's security repository by days, and openssl alone
#     accounted for a CRITICAL and fourteen HIGH findings on a fresh build.
#  2. npm, npx, corepack and yarn are deleted. The service runs `node`; it never
#     needs a package manager at runtime. The npm CLI vendors around twenty of
#     its own dependencies (tar, minimatch, glob, cross-spawn, sigstore, …) and
#     those carried every remaining HIGH and CRITICAL finding — none of them
#     reachable from application code, all of them blocking a deploy.
RUN apk --no-cache upgrade \
    && rm -rf /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /usr/local/bin/yarn /usr/local/bin/yarnpkg \
    /opt/yarn-* \
    && addgroup -g 10001 -S app \
    && adduser -u 10001 -S app -G app

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --from=deps --chown=app:app /rds-global-bundle.pem ./certs/rds-global-bundle.pem

# The whole application tree, with .dockerignore deciding what stays out.
#
# This used to be an allowlist — `COPY src ./src` plus `COPY public ./public` —
# and that silently dropped every directory added later. A `db/migrations/`
# directory existed in the repo, never reached the image, and the migration Job
# failed with ENOENT inside a `kubectl wait` that reported only "timed out".
# An allowlist here fails quietly; .dockerignore fails visibly.
COPY --chown=app:app . .

# The lockfile did its job in the deps stage. Leaving it here would make the
# image scanner report devDependency CVEs for packages that were never
# installed — findings that block a deploy and mean nothing at run time.
RUN rm -f package-lock.json npm-shrinkwrap.json

USER app

EXPOSE 3000

# Node 20 ships a global fetch, so the check needs no extra tooling in the image.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# Exec form: node runs as PID 1 and receives SIGTERM directly, which is what
# makes the graceful drain in src/server.js work.
ENTRYPOINT ["node", "src/server.js"]
