# Build stage
FROM node:22-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# Build with production API base URL (relative path for nginx proxy)
ENV VITE_API_BASE_URL=/api/v1
RUN npm run build

# Runtime stage
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
