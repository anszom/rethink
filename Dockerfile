FROM node:trixie

# Create app directory
WORKDIR /rethink

# Copy project
COPY ./rethink /rethink

# Install dependencies
RUN npm install
RUN npm run build

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Expose ports
EXPOSE 443
EXPOSE 4433
EXPOSE 8884
EXPOSE 1884

ENTRYPOINT ["/entrypoint.sh"]
