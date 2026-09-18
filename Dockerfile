FROM node:20-alpine

WORKDIR /app

COPY package.json ./
# No external dependencies today, but keep this here so adding one later
# (e.g. swapping in a real LLM SDK) doesn't require touching the Dockerfile.
RUN npm install --omit=dev --no-audit --no-fund || true

COPY . .

ENV PORT=3000
EXPOSE 3000

CMD ["node", "index.js"]
