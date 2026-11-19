# COLLABSPHERE

Full-stack real-time collaboration workspace.

## Structure

- `client/`: React, TypeScript, Vite, Tailwind CSS, and Shadcn UI configuration
- `server/`: Express, TypeScript, Prisma, and PostgreSQL API
- `server/prisma/schema.prisma`: Multi-tenant collaboration data model

## Setup

1. Install dependencies with `npm install`.
2. Start PostgreSQL with `docker compose up -d postgres`.
3. Copy `server/.env.example` to `server/.env`.
4. Generate Prisma Client with `npm run db:generate`.
5. Apply the schema with `npm run db:push`.
6. Run the API with `npm run dev` and the client with `npm run dev:client`.

The API health endpoint is available at `http://localhost:4000/health`.
