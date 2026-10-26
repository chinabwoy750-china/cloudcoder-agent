FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl ca-certificates ripgrep unzip \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g opencode-ai@latest \
    && opencode --version

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY src ./src

RUN useradd -m -s /bin/bash cloudcoder \
    && mkdir -p \
         /home/cloudcoder/.local/share/opencode \
         /home/cloudcoder/.config/opencode \
         /tmp/cloudcoder \
    && chown -R cloudcoder:cloudcoder /app /home/cloudcoder /tmp/cloudcoder

USER cloudcoder
ENV HOME=/home/cloudcoder
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"
EXPOSE 10000
CMD ["node", "src/index.js"]
