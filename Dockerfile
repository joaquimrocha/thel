# Builds the Linux bundles (deb/rpm/AppImage) in a container.
#
#   docker build -t thel-build .
#   id=$(docker create thel-build)
#   docker cp "$id:/app/src-tauri/target/release/bundle" ./bundle
#   docker rm "$id"
#
# Linux only. This produces Linux artifacts; cross-building macOS/Windows
# bundles from here is not supported by Tauri.
FROM node:20-bookworm

# Tauri 2 system libraries (see https://v2.tauri.app/start/prerequisites/).
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev \
      libgtk-3-dev \
      libsoup-3.0-dev \
      librsvg2-dev \
      libssl-dev \
      libayatana-appindicator3-dev \
      build-essential pkg-config curl wget file \
    && rm -rf /var/lib/apt/lists/*

# Rust stable via rustup.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

RUN npm install -g pnpm

WORKDIR /app

# Install JS deps first so this layer caches until the lockfile changes.
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm tauri build
