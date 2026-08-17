# Bothost монтирует /app с Git — код и node_modules держим вне /app
FROM node:22-bookworm-slim

WORKDIR /usr/src/app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# База и загрузки — в volume Bothost (/app/data)
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

EXPOSE 3000
CMD ["node", "server/index.js"]
