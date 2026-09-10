FROM registry.access.redhat.com/ubi9/nodejs-24@sha256:67ec5beb77fbfece2cb7e2367886c42269b9a1713aeab187767370b0684a1752 AS verify
USER 0
WORKDIR /opt/talember
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV WRANGLER_WRITE_LOGS=false WRANGLER_SEND_METRICS=false WRANGLER_SEND_ERROR_REPORTS=false CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV=false
RUN cat /etc/redhat-release && node --version && npm --version \
    && npm run typecheck && npm run lint && npm test && npm run build
