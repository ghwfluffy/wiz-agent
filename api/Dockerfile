FROM node:22-bookworm-slim AS build

WORKDIR /workspace/api

COPY api/package*.json ./
RUN npm ci

COPY api/ ./
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /workspace/api
COPY api/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /workspace/api/dist ./dist

EXPOSE 8000
CMD ["npm", "start"]
