# Node 22.23.1 is the lowest supported LTS runtime in the dependency contract
# (^22.23.1 || ^24.0.0). Keep the patch version and image digest immutable.
FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder

WORKDIR /app
COPY package*.json ./
COPY scripts/check-runtime-contract.mjs ./scripts/check-runtime-contract.mjs
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22.23.1-alpine3.24@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

ARG COREONE_RELEASE_SHA
RUN printf '%s' "$COREONE_RELEASE_SHA" | grep -Eq '^[0-9a-f]{40}$'
LABEL org.opencontainers.image.revision=$COREONE_RELEASE_SHA

WORKDIR /app
COPY package*.json ./
COPY scripts/check-runtime-contract.mjs ./scripts/check-runtime-contract.mjs
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/start-production.mjs ./scripts/start-production.mjs
COPY --chown=node:node release/lib.mjs release/verify-volume-migration.mjs ./release/

RUN mkdir -p /app/data && chown node:node /app/data

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

USER node

HEALTHCHECK --interval=30s --timeout=10s --start-period=20s --retries=3 \
  CMD node --experimental-sqlite -e "const {DatabaseSync}=require('node:sqlite');let db;try{db=new DatabaseSync('/app/data/coreone.db',{readOnly:true});if(!db.prepare(\"SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='users'\").get()?.ok)throw new Error('users schema missing')}catch{process.exit(1)}finally{db?.close()}fetch('http://127.0.0.1:3001/api/health',{signal:AbortSignal.timeout(5000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--experimental-sqlite", "scripts/start-production.mjs"]
