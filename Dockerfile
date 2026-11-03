# syntax=docker/dockerfile:1

# ---- frontend ----
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ .
RUN npx ng build --configuration production

# ---- backend ----
FROM node:22-bookworm-slim AS api
WORKDIR /api
COPY backend/package*.json ./
RUN npm ci
COPY backend/ .
RUN npm run build && npm prune --omit=dev

# ---- runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data PORT=3000
WORKDIR /app
# package.json is needed at runtime: the backend is ESM ("type": "module").
COPY --from=api /api/package.json ./package.json
COPY --from=api /api/dist ./dist
COPY --from=api /api/node_modules ./node_modules
COPY --from=web /web/dist/frontend/browser ./public
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/main.js"]
