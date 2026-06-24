FROM node:20-slim

WORKDIR /app

# Installer kun produktionsafhængigheder (Baileys' optionelle native deps
# som sharp/jimp er ikke nødvendige for at sende tekstbeskeder).
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --omit=optional || npm install --omit=dev --omit=optional

COPY server.js ./

ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080

# Persistent WhatsApp-session
VOLUME ["/data"]

CMD ["node", "server.js"]
