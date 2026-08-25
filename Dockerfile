FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/PIGGYcloudy/mermaid-flow-editor"
ENV NODE_ENV=production
ENV PORT=3000
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
RUN chmod -R a+rX /app/dist /app/server /app/shared
EXPOSE 3000
USER node
CMD ["npm", "start"]
