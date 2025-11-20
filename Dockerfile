# Use a small, recent Ubuntu LTS
FROM ubuntu:24.04

# Avoid interactive prompts during package installs
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# Install nodejs and npm via apt (silent)
# Note: Ubuntu repo versions may be older; if you want newer Node, consider NodeSource or nvm.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      gnupg \
      nodejs \
      npm \
 && rm -rf /var/lib/apt/lists/*

# Create app directory and set as working dir
WORKDIR /rethink

# Copy application files into the image
# Make sure your build context contains the ./rethink folder
COPY ./rethink /rethink

# Install dependencies at build time.
# Prefer npm ci when package-lock.json is present for deterministic installs,
# otherwise fall back to npm install.
RUN if [ -f package-lock.json ]; then \
      npm ci --only=production; \
    else \
      npm install --production; \
    fi

# Expose port(s) if your app uses any (adjust as needed)
EXPOSE 4433

# Entrypoint / command: run your app
CMD ["node", "rethink-cloud.js"]