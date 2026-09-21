# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim

WORKDIR /var/www/html/accounting-service

RUN apt-get update && apt-get install -y \
    openssl \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
COPY prisma ./prisma

RUN npm ci --include=dev

RUN npx prisma generate

COPY . .

COPY docker/node/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 4005

CMD ["sh", "-c", "npm run build && npm run start"]
