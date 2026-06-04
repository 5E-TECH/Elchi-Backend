FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx nest build api-gateway

FROM node:20-alpine
# DejaVu fonts give the printer PDF (apps/api-gateway/src/printer) full
# Cyrillic + Latin coverage; without them pdfkit falls back to Helvetica.
RUN apk add --no-cache font-dejavu
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
CMD ["node", "dist/apps/api-gateway/main.js"]
