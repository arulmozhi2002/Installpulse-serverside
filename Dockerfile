FROM node:20-slim

# Build tools needed to compile @whiskeysockets/libsignal-node (native C++ module)
RUN apt-get update \
    && apt-get install -y build-essential python3 git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src/app

COPY package*.json .npmrc ./
RUN git config --global url."https://github.com/".insteadOf "ssh://git@github.com/" \
    && npm install

COPY . .

EXPOSE 3000
CMD ["node", "--max-old-space-size=400", "index.js"]


