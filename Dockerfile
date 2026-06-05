FROM node:20-alpine
WORKDIR /app
COPY server.js .
COPY dashboard.html .
EXPOSE 8080
CMD ["node", "server.js"]
