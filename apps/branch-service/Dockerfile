FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx nest build branch-service

# Runtime dependencies only. This stage is built from package*.json alone, so
# its layers are byte-identical for every service and all 14 images share one
# node_modules instead of each carrying its own copy. It also drops the build
# toolchain (typescript, @nestjs/cli, webpack, eslint...) the runtime never
# loads.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
# The logger falls back to pino-pretty (a devDependency) off production, so the
# image pins the env it was built for rather than trusting the caller's.
ENV NODE_ENV=production
WORKDIR /app
# Shared layers first: anything service-specific copied ahead of them forks the
# layer chain and stops them being shared. dist is a few hundred KB, so it goes
# last.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=builder /app/dist ./dist
# qUEE0Bgd: ilova root ostida ishlamaydi. Fayllar root'niki bo'lib qoladi (ilova
# o'z kodini o'zgartira olmaydi), chown yo'q — umumiy qatlamlar buzilmaydi. USER
# qatlam yaratmaydi; hech narsa diskka yozilmaydi (multer memoryStorage, log
# stdout), /tmp ochiq.
USER node
CMD ["node", "dist/apps/branch-service/main.js"]
