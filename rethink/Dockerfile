# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# Production stage
FROM node:20-alpine
RUN apk add --no-cache openssl
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./

# NOTE: the port numbers may be modified in config.json !
EXPOSE 4433 8884 1884 46030 47878 44401
VOLUME /app/data
CMD ["node", "dist/rethink-cloud.js"]
