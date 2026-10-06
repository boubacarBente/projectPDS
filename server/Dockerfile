# Serveur central de synchronisation Planète Déco
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY index.mjs sync-scopes.mjs ./
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "index.mjs"]
