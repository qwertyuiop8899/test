# Scegli un'immagine Node.js di base
FROM node:18-slim

# Installa git e dipendenze build necessarie
USER root 
RUN apt-get update && apt-get install -y git ca-certificates python3 make g++ --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Imposta la directory di lavoro nell'immagine
WORKDIR /usr/src/app

# Clona il repository Git
ARG GIT_REPO_URL="https://github.com/qwertyuiop8899/test.git"
ARG GIT_BRANCH="main"
RUN git -c http.sslVerify=false clone --branch ${GIT_BRANCH} --depth 1 ${GIT_REPO_URL} .

# Installa le dipendenze del progetto
USER root
RUN corepack enable && corepack prepare pnpm@$(node -p "require('./package.json').packageManager.split('@')[1]") --activate

# SOLO FIX: Installa types mancanti per risolvere errore TypeScript
RUN pnpm add -D @types/stremio-addon-sdk@^1.6.12

# Assicura che l'utente node sia proprietario della directory dell'app e del suo contenuto
RUN chown -R node:node /usr/src/app

# Torna all'utente node per le operazioni di pnpm e l'esecuzione dell'app
USER node

# Installa tutte le dipendenze incluse quelle di sviluppo
RUN pnpm install --prod=false

# Esegui il build dell'applicazione TypeScript
RUN pnpm run build

# Rimuovi le devDependencies dopo il build per ridurre dimensione immagine
RUN pnpm prune --prod

# Esponi la porta per Hugging Face
EXPOSE 7860

# Definisci il comando per avviare l'applicazione
CMD [ "pnpm", "start" ]
