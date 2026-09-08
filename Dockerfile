# syntax=docker/dockerfile:1
# Vibe Distribution app — single Node image serving the API and the built web client.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/brain/brain.json ./server/brain/brain.json
EXPOSE 8787
CMD ["node", "dist/server/server/index.js"]
