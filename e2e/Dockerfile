FROM node:22-slim

# System deps: git (for claude code), curl (for health checks), mkcert deps
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      git curl ca-certificates procps libnss3-tools && \
    rm -rf /var/lib/apt/lists/*

# Install mkcert and pre-trust the CA system-wide (as root)
RUN curl -L -o /usr/local/bin/mkcert \
      "https://dl.filippo.io/mkcert/latest?for=linux/amd64" && \
    chmod +x /usr/local/bin/mkcert && \
    mkcert -install

# Install cloudflared (for tunnel setup during skill test)
RUN curl -L -o /usr/local/bin/cloudflared \
      "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" && \
    chmod +x /usr/local/bin/cloudflared

# Install openclaw globally
RUN npm install -g openclaw@2026.2.23

# Install claude code globally
RUN npm install -g @anthropic-ai/claude-code

# Create a non-root user with home directory
RUN useradd -m -s /bin/bash dev

# Copy root's mkcert CA to dev user so both share the same system-trusted CA
RUN mkdir -p /home/dev/.local/share/mkcert && \
    cp /root/.local/share/mkcert/rootCA.pem /home/dev/.local/share/mkcert/ && \
    cp /root/.local/share/mkcert/rootCA-key.pem /home/dev/.local/share/mkcert/ && \
    chown -R dev:dev /home/dev/.local

USER dev
WORKDIR /home/dev

# Create ~/.local/bin and add to PATH for user-local installs
RUN mkdir -p /home/dev/.local/bin && \
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> /home/dev/.bashrc

# Bootstrap minimal openclaw config (gateway only, no remoteclaw plugin)
RUN mkdir -p /home/dev/.openclaw
COPY --chown=dev:dev openclaw.json /home/dev/.openclaw/openclaw.json

# RemoteClaw source will be mounted at /home/dev/remoteclaw
# (not pre-configured — the agent should set it up via SETUP_SKILL)

COPY --chown=dev:dev entrypoint.sh /home/dev/entrypoint.sh

ENTRYPOINT ["/home/dev/entrypoint.sh"]
CMD ["bash"]
