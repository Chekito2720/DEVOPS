# API REST - Categorias, Productos y Pedidos

API REST con Node.js, Express y SQLite (better-sqlite3), con pipeline CI/CD automatizado: pruebas con Jest, imagen Docker publicada en Docker Hub y despliegue automatico en AWS EC2 mediante GitHub Actions.

**Autor:** Sergio Abdiel Gonzalez Bravo

## Arquitectura

```
[ GitHub (push a main) ]
        |
        v
[ GitHub Actions: CI/CD (.github/workflows/main.yml) ]
    1. test            -> npm ci + npm test (Jest + Supertest, cobertura >= 70%)
    2. build-and-push  -> docker build + push a Docker Hub (:latest y :sha)
    3. deploy          -> SSH a EC2, docker pull + restart del contenedor
        |
        v
[ AWS EC2 (Ubuntu + Docker) ]
    Contenedor api-cicd en el puerto 80 (HTTP) y 6061 (TCP)
    BD SQLite en volumen ./data (persistente)
```

### Estructura del proyecto

| Archivo | Funcion |
|---|---|
| `app.js` | Logica de la API: rutas, validaciones y respuestas (sin `.listen`, testeable) |
| `server.js` | Punto de entrada: levanta el servidor HTTP (puerto 80) y el servidor TCP (6061) |
| `db.js` | Conexion a SQLite: `:memory:` en tests, archivo en produccion + `resetDb()` |
| `seed.sql` | Datos iniciales (3 categorias, 6 productos, 3 pedidos) |
| `tests/api.test.js` | 29 pruebas unitarias/de integracion con Jest + Supertest |
| `Dockerfile` | Imagen Docker optimizada (node:20-slim, `npm ci --omit=dev`) |
| `.dockerignore` | Excluye node_modules, .env, logs, data, coverage, etc. |
| `.github/workflows/main.yml` | Pipeline CI/CD (test -> build -> deploy) |

## Endpoints (11)

| # | Metodo | Ruta | Descripcion |
|---|---|---|---|
| 0 | GET | `/api/health` | Healthcheck con nombre del autor |
| 1 | GET | `/api/categorias` | Lista categorias |
| 2 | POST | `/api/categorias` | Crea categoria (400 si falta nombre, 409 duplicada) |
| 3 | DELETE | `/api/categorias/:id` | Elimina categoria (404 inexistente, 400 id invalido, 409 con productos) |
| 4 | GET | `/api/productos` | Lista productos con su categoria (JOIN) |
| 5 | POST | `/api/productos` | Crea producto (400 campos/precio/categoria invalidos) |
| 6 | DELETE | `/api/productos/:id` | Elimina producto (404 inexistente, 409 con pedidos) |
| 7 | GET | `/api/pedidos` | Lista pedidos con producto (JOIN) |
| 8 | POST | `/api/pedidos` | Crea pedido (400 producto inexistente o cantidad <= 0) |
| 9 | GET | `/api/db/backup` | Genera respaldo de la BD |
| 10 | DELETE | `/api/db/clear` | Vacia todas las tablas |

Ademas, un servidor TCP crudo en el puerto **6061** acepta `{insert:<json>}` y `{get:<json>}`.

## Comandos locales

```bash
# Instalar dependencias
npm install

# Ejecutar servidor (HTTP 80 + TCP 6061)
npm start

# Ejecutar pruebas con cobertura (umbral 70%; falla si no se alcanza)
npm test

# Compilar y correr la imagen Docker localmente
docker build -t webapp .
docker run -p 80:80 -p 6061:6061 webapp
```

Las pruebas usan SQLite **en memoria** (`NODE_ENV=test`), por lo que nunca tocan la BD real.

## Pipeline CI/CD (GitHub Actions)

El workflow se dispara en cada `push` y `pull_request` hacia `main`:

1. **test:** instala dependencias con `npm ci` y corre `npm test`. Jest genera el reporte de cobertura en `coverage/` y **falla el pipeline si el umbral del 70% no se alcanza** (`coverageThreshold`).
2. **build-and-push** (solo en push a main): inicia sesion en Docker Hub con el PAT y publica la imagen con los tags `:latest` y `:${{ github.sha }}` (hash del commit).
3. **deploy** (solo en push a main): se conecta por SSH a la EC2, descarga la imagen mas reciente, detiene/elimina el contenedor anterior y levanta la nueva version en el puerto 80.

## Configuracion de GitHub Secrets

En **Settings -> Secrets and variables -> Actions** del repositorio:

| Secret | Contenido |
|---|---|
| `DOCKERHUB_USERNAME` | Usuario de Docker Hub |
| `DOCKERHUB_TOKEN` | Personal Access Token de Docker Hub (no la contrasena) |
| `EC2_HOST` | IP publica de la instancia EC2 |
| `EC2_SSH_KEY` | Contenido **completo** de la clave `.pem` (incluye lineas BEGIN/END) |

## Configuracion de la instancia AWS EC2

1. Instancia **Ubuntu Server** (ej. t2.micro) con Security Group:
   - Puerto **22** (SSH) abierto solo a tu IP.
   - Puerto **80** (HTTP) abierto a `0.0.0.0/0`.
2. Instalar Docker en la instancia:
   ```bash
   sudo apt update && sudo apt install -y docker.io
   sudo usermod -aG docker ubuntu
   ```
3. Guardar la clave `.pem` localmente y su contenido en el secret `EC2_SSH_KEY` (nunca subir el archivo al repositorio).

## Despliegue y demostracion

Una vez configurado, cada `git push` a `main`:

```bash
git add .
git commit -m "demo: actualizar mensaje de health"
git push
```

ejecuta automaticamente: **tests -> imagen Docker -> Docker Hub -> despliegue en EC2**. La API publica queda en:

```
http://<IP_EC2>/api/health
http://<IP_EC2>/api/categorias
http://<IP_EC2>/api/productos
http://<IP_EC2>/api/pedidos
```

Sin intervention manual en el servidor y sin tiempo de inactividad perceptible.
