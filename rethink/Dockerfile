# Build stage
FROM alpine:3.20 AS build
WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev

# Production stage
FROM alpine:3.20 AS runtime
WORKDIR /app

RUN apk add --no-cache nodejs openssl jq \
	&& addgroup -S app \
	&& adduser -S -G app app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY config.json /app/config.json
COPY run.sh /app/run.sh

RUN chmod +x /app/run.sh

RUN mkdir -p /app/data

EXPOSE 4433 8884 1884 46030 47878 44401
CMD ["/app/run.sh"]
