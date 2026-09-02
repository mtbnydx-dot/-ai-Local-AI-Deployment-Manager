FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV SEARCH_GATEWAY_HOST=0.0.0.0
ENV SEARCH_GATEWAY_PORT=5180

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY server.js search-core.js safe-reader.js ./

EXPOSE 5180
CMD ["node", "server.js"]
