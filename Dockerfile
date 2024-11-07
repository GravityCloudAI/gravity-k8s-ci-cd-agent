FROM node:20-bookworm

# Install dependencies for Buildah and Docker
RUN apt-get update \
    && apt-get install -y \
    apt-transport-https \
    ca-certificates \
    curl \
    gnupg \
    lsb-release \
    software-properties-common \
    python3-pip python3-dev unzip \
    iptables

# Add the official repositories for Buildah
# RUN . /etc/os-release \
#     && echo "deb http://download.opensuse.org/repositories/devel:/kubic:/libcontainers:/stable/Debian_$VERSION_ID/ /" > /etc/apt/sources.list.d/devel:kubic:libcontainers:stable.list \
#     && curl -L https://download.opensuse.org/repositories/devel:kubic:libcontainers:stable/Debian_$VERSION_ID/Release.key | apt-key add -

RUN echo "deb http://deb.debian.org/debian sid main" | tee /etc/apt/sources.list.d/sid.list

# RUN echo "deb http://deb.debian.org/debian bullseye-backports main" | tee /etc/apt/sources.list.d/bullseye-backports.list

# Install Buildah
RUN apt-get update \
    && apt-get -t sid install -y buildah

# Verify Buildah installation
RUN echo "Buildah version: $(buildah --version)"

# Install AWS CLI
RUN pip3 install awscli --upgrade --break-system-packages

# Set AWS CLI pager to empty
RUN aws configure set cli_pager ""

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
CMD [ "npm", "start" ]
