# Build stage
FROM alpine:3.20 AS build
WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

# Production stage
FROM alpine:3.20 AS runtime
WORKDIR /app

RUN apk add --no-cache nodejs openssl \
	&& addgroup -S app \
	&& adduser -S -G app app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.json /app/config.json

RUN mkdir -p /app/data

EXPOSE 4433 8884 1884 46030 47878 44401
CMD ["sh", "-c", "[ -f /app/data/config.json ] || cp /app/config.json /app/data/config.json; exec node dist/rethink-cloud.js /app/data/config.json"]
