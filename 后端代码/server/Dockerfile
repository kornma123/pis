FROM node:22-alpine

WORKDIR /app

# Install dependencies (include devDeps for tsx)
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["npx", "tsx", "src/app.ts"]
