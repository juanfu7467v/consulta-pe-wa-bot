# Usa Node.js 20 LTS
FROM node:20

# Crea directorio de la app
WORKDIR /app

# Copia package.json y package-lock.json (si existe)
COPY package*.json ./

# Instala dependencias
RUN npm install --omit=dev

# Copia el resto del proyecto
COPY . .

# Exponer puerto Fly.io
EXPOSE 3000

# Arrancar servidor
CMD ["npm", "start"]
