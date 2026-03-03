FROM node:20-alpine

ARG APP_VERSION=1.0.0
ARG BUILD_TIME=unknown

WORKDIR /app

# Dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# App source
COPY app.js .

# Bake version into image at build time
ENV APP_NAME=gce-zero2prod
ENV APP_VERSION=${APP_VERSION}
ENV BUILD_TIME=${BUILD_TIME}
ENV PORT=3000

EXPOSE 3000

CMD ["node", "app.js"]
