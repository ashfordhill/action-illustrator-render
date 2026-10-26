FROM node:22-bookworm-slim

WORKDIR /renderer

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && \
    npx playwright install --with-deps --only-shell chromium && \
    rm -rf /var/lib/apt/lists/* /root/.npm

COPY render.mjs ./

WORKDIR /workspace

ENTRYPOINT ["node", "/renderer/render.mjs"]
