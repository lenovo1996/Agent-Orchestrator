FROM node:22-slim

# Install basic dependencies
RUN apt-get update && apt-get install -y \
    git \
    curl \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

# Install uv for Python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

# Install codex CLI
RUN npm install -g @openai/codex

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY dashboard/package*.json ./dashboard/
COPY dashboard/shared/package*.json ./dashboard/shared/
COPY dashboard/orchestration/package*.json ./dashboard/orchestration/
COPY dashboard/server/package*.json ./dashboard/server/
COPY dashboard/client/package*.json ./dashboard/client/
COPY mcp/package*.json ./mcp/

# Copy agents directory
COPY agents/ ./agents/

# Install dependencies
RUN cd dashboard && npm install

# Copy source code
COPY . .

# Build TypeScript
RUN cd dashboard && npm run build

# Default command
CMD ["npm", "run", "dev"]
