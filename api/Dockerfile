FROM node:20-bookworm-slim

WORKDIR /workspace/api

COPY api/package*.json ./
RUN npm install

COPY api/ ./
RUN npm run build

EXPOSE 8000
CMD ["npm", "start"]
