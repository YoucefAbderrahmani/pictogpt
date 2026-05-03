FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev
COPY index.js documentAi.js .
ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787
CMD ["node", "index.js"]
