FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV SEARCH_GATEWAY_HOST=0.0.0.0
ENV SEARCH_GATEWAY_PORT=5180

COPY package.json server.js search-core.js safe-reader.js ./

EXPOSE 5180
CMD ["node", "server.js"]
