FROM node:20-bookworm-slim AS build

ARG VITE_APP_BASE_PATH=
ARG VITE_API_BASE_URL=/api/v1
ARG VITE_AUTH_MODE=standalone

ENV VITE_APP_BASE_PATH=${VITE_APP_BASE_PATH}
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
ENV VITE_AUTH_MODE=${VITE_AUTH_MODE}

WORKDIR /workspace/web
COPY web/package*.json ./
RUN npm install
COPY web/ ./
RUN npm run build

FROM nginx:stable-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /workspace/web/dist /usr/share/nginx/html
