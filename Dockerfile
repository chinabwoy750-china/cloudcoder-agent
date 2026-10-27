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
COPY .opencode/skills/ /tmp/um-skills/

RUN useradd -m -s /bin/bash cloudcoder \
    && mkdir -p \
         /home/cloudcoder/.local/share/opencode \
         /home/cloudcoder/.config/opencode/skills \
         /tmp/cloudcoder \
    && cp -R /tmp/um-skills/. /home/cloudcoder/.config/opencode/skills/ \
    && rm -rf /tmp/um-skills \
    && git clone --depth 1 https://github.com/affaan-m/ECC.git /tmp/ECC \
    && for skill in frontend-patterns tdd-workflow verification-loop security-review; do \
         if [ -f "/tmp/ECC/skills/${skill}/SKILL.md" ]; then \
           mkdir -p "/home/cloudcoder/.config/opencode/skills/${skill}"; \
           cp -R "/tmp/ECC/skills/${skill}/." \
             "/home/cloudcoder/.config/opencode/skills/${skill}/"; \
         else \
           echo "ECC skill not found: ${skill}"; \
         fi; \
       done \
    && rm -rf /tmp/ECC \
    && chown -R cloudcoder:cloudcoder /app /home/cloudcoder /tmp/cloudcoder

USER cloudcoder
ENV HOME=/home/cloudcoder
ENV NODE_ENV=production
ENV PATH="/usr/local/bin:/usr/bin:/bin:${PATH}"
EXPOSE 10000
CMD ["node", "src/index.js"]
