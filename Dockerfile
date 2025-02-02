FROM node:22.11.0-bookworm-slim

# Install dependencies for Buildah and Docker
RUN apt-get update && apt-get install -y --no-install-recommends \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    unzip \
    iptables \
    git \
    skopeo \
    && rm -rf /var/lib/apt/lists/*

RUN echo "deb http://deb.debian.org/debian sid main" | tee /etc/apt/sources.list.d/sid.list

# Install Buildah
RUN apt-get update \
    && apt-get -t sid install -y buildah

# Verify Buildah installation
RUN echo "Buildah version: $(buildah --version)"

# Install AWS CLI v2
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        ARCH="amd64"; \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        ARCH="arm64"; \
        curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    else \
        echo "Unsupported architecture: $ARCH"; exit 1; \
    fi && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf awscliv2.zip aws

# Set AWS CLI pager to empty
RUN aws configure set cli_pager ""

# install kubectl
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        ARCH="arm64"; \
    else \
        echo "Unsupported architecture: $ARCH"; exit 1; \
    fi && \
    curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/$ARCH/kubectl" && \
    install -o root -g root -m 0755 kubectl /usr/local/bin/kubectl

# Install Helm
RUN curl -fsSL -o get_helm.sh https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 \
    && chmod 700 get_helm.sh \
    && ./get_helm.sh

RUN helm version --short

RUN BUILDKIT_VERSION=v0.19.0 && \
    RUNC_VERSION=v1.2.24 && \
    ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
        ARCH="amd64"; \
    elif [ "$ARCH" = "aarch64" ]; then \
        ARCH="arm64"; \
    else \
        echo "Unsupported architecture: $ARCH"; exit 1; \
    fi && \
    # Install runc
    curl -LO "https://github.com/opencontainers/runc/releases/download/${RUNC_VERSION}/runc.${ARCH}" && \
    install -m 755 runc.${ARCH} /usr/local/bin/runc && \
    rm runc.${ARCH} && \
    # Install BuildKit
    curl -LO "https://github.com/moby/buildkit/releases/download/${BUILDKIT_VERSION}/buildkit-${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz" && \
    tar xzvf buildkit-${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz && \
    mv bin/buildctl /usr/local/bin/ && \
    mv bin/buildkitd /usr/local/bin/ && \
    rm -rf bin buildkit-${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz


RUN mkdir -p /etc/buildkit && \
    echo '[worker.oci]' > /etc/buildkit/buildkitd.toml && \
    echo '  max-parallelism = 50' >> /etc/buildkit/buildkitd.toml && \
    echo '[registry."gravity-docker-registry:5000"]' > /etc/buildkit/buildkitd.toml && \
    echo '  http = true' >> /etc/buildkit/buildkitd.toml && \
    echo '  insecure = true' >> /etc/buildkit/buildkitd.toml

# Create the working directory
WORKDIR /usr/src/app

# Copy package files and install npm dependencies
COPY --chown=node:node package*.json /usr/src/app/
RUN npm clean-install

# Copy source files
COPY --chown=node:node . /usr/src/app/
RUN mkdir /usr/src/app/image-cache

# Build the Node.js application
RUN npm run build

# Set the user to root to run Buildah if needed
USER root

VOLUME /var/lib/containers

# Start the application
# CMD [ "npm", "start" ]

CMD ["sh", "-c", "buildkitd --config /etc/buildkit/buildkitd.toml & npm start"]
