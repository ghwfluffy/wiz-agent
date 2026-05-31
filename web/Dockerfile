FROM node:20-bookworm-slim

WORKDIR /workspace/web

COPY web/package*.json ./
RUN npm install

COPY web/ ./
RUN npm run build

EXPOSE 8081
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0", "--port", "8081"]
