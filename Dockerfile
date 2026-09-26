FROM node:22.12-alpine AS builder


COPY . /app
WORKDIR /app


RUN --mount=type=cache,target=/root/.npm npm install

FROM node:22-alpine AS release

WORKDIR /app

# Coolify's health check calls curl; busybox wget tries ::1 only and fails.
RUN apk add --no-cache curl


COPY --from=builder /app/*.js /app/
COPY --from=builder /app/catalog.json /app/
COPY --from=builder /app/package.json /app/
COPY --from=builder /app/package-lock.json /app/


ENV NODE_ENV=production


RUN npm ci --ignore-scripts --omit-dev

EXPOSE 3000

ENTRYPOINT ["node", "server.js"]
