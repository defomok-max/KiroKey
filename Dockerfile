FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOME=/home/kiro \
    HOST=0.0.0.0 \
    PORT=11437 \
    KIRO_SERVER_MODE=1 \
    KIRO_TOKEN_DIR=/data/aws-sso-cache
RUN addgroup -S kiro && adduser -S -G kiro -h /home/kiro kiro && mkdir -p /data/aws-sso-cache /home/kiro/.kiro-router && chown -R kiro:kiro /data /home/kiro
COPY --from=build --chown=kiro:kiro /app/package.json /app/package-lock.json ./
COPY --from=build --chown=kiro:kiro /app/node_modules ./node_modules
COPY --from=build --chown=kiro:kiro /app/dist ./dist
USER kiro
EXPOSE 11437
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||11437)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
