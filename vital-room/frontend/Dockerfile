# Stealth Vital Web — frontend (Next.js)
FROM node:20-slim

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
ARG BACKEND_INTERNAL_URL=http://backend:8000
ENV BACKEND_INTERNAL_URL=$BACKEND_INTERNAL_URL
RUN npm run build

EXPOSE 3000
CMD ["npm", "run", "start"]
