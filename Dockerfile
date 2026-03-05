ARG APP_VERSION=1.0.0
ARG BUILD_TIME=unknown

FROM node:20-alpine

WORKDIR /app

# Dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Source
COPY app.js .
COPY scripts/ ./scripts/

# Env baked at build time
ENV APP_NAME=cloudrun-zero2prod
ENV APP_VERSION=${APP_VERSION}
ENV BUILD_TIME=${BUILD_TIME}
ENV PORT=8080

EXPOSE 8080

CMD ["node", "app.js"]
