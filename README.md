# Askly AI Chatbot with Custom PostgreSQL Authentication

Askly is an AI chatbot powered by the Sela v1 model, featuring a custom, secure authentication system built with **Node.js, Express, PostgreSQL, Passport.js, and HTTP-only cookie sessions** without Firebase or any managed authentication service.

---

## Features

- **Custom Authentication (No Firebase/Supabase/Clerk)**:
  - Email/Password Sign Up with bcrypt hashing (minimum 8 characters)
  - Secure Login with rate limiting to prevent brute force attacks
  - Logout with server-side session destruction and cookie clearing
  - Session verification (`GET /api/auth/me`)
- **OAuth 2.0 Integration via Passport.js**:
  - **Google Login** (`/api/auth/google`, `/api/auth/google/callback`)
  - **Facebook Login** (`/api/auth/facebook`, `/api/auth/facebook/callback`)
  - Automatically locates existing users by provider ID or email, or creates a new user profile
- **PostgreSQL Database Storage**:
  - `users` table: ID, name, email (unique), password_hash, google_id (unique), facebook_id (unique), timestamps
  - `chat_messages` table: ID, user_id (foreign key with cascade), role, message, created_at
  - `session` table: PostgreSQL-backed sessions using `connect-pg-simple`
  - Performance indexes on email, provider IDs, user IDs, and timestamps
- **Per-User Private Chat History**:
  - Every logged-in user has their own private conversation history
  - User messages and AI responses are automatically saved with the authenticated session user ID
  - Users can never access or view another user's chat history
  - Endpoints to retrieve (`GET /api/chat/history`) and clear (`DELETE /api/chat/history`) private history
- **Security Best Practices**:
  - Passwords hashed with bcrypt (salt rounds: 10)
  - `httpOnly`, `sameSite: 'lax'`, and `secure` cookie configuration
  - Parameterized SQL queries preventing SQL injection
  - `express-rate-limit` protection on authentication endpoints
  - Secrets strictly managed via environment variables (never exposed to frontend)
  - User IDs always resolved from server session, never trusted from client request bodies

---

## Project Structure

```
├── db/
│   ├── index.ts        # Database connection pool & parameterized query helpers
│   └── schema.sql      # PostgreSQL schema, tables, foreign keys, and indexes
├── middleware/
│   ├── auth.ts         # Authentication verification middleware (requireAuth)
│   └── rateLimiter.ts  # Express rate limiting for auth endpoints
├── passport/
│   └── index.ts        # Passport.js Google & Facebook OAuth strategies
├── routes/
│   ├── auth.ts         # /api/auth (signup, login, logout, me, google, facebook)
│   └── chat.ts         # /api/chat (history retrieval, delete, send message)
├── src/
│   ├── components/
│   │   ├── AuthModal.tsx   # Login/Signup modal with Google & Facebook buttons
│   │   ├── Header.tsx      # App header with language selector
│   │   └── ...
│   └── App.tsx         # Chatbot UI, state management, and auth flow
├── server.ts           # Express server, session configuration, Vite middleware
├── .env.example        # Template for required environment variables
└── package.json        # Dependencies & scripts
```

---

## Database Schema (`db/schema.sql`)

```sql
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    google_id VARCHAR(255) UNIQUE,
    facebook_id VARCHAR(255) UNIQUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_messages (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS session (
    sid VARCHAR NOT NULL COLLATE "default",
    sess JSON NOT NULL,
    expire TIMESTAMP(6) NOT NULL,
    CONSTRAINT session_pkey PRIMARY KEY (sid) NOT DEFERRABLE INITIALLY IMMEDIATE
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id);
CREATE INDEX IF NOT EXISTS idx_users_facebook_id ON users(facebook_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_id ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages(created_at);
CREATE INDEX IF NOT EXISTS idx_session_expire ON session(expire);
```

---

## Environment Variables Configuration

Copy `.env.example` to `.env` and configure the values:

```bash
PORT=3000
DATABASE_URL=postgresql://postgres:password@localhost:5432/askly_db
SESSION_SECRET=your_long_random_session_secret_change_in_production
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_CALLBACK_URL=http://localhost:3000/api/auth/google/callback
FACEBOOK_APP_ID=your_facebook_app_id
FACEBOOK_APP_SECRET=your_facebook_app_secret
FACEBOOK_CALLBACK_URL=http://localhost:3000/api/auth/facebook/callback
FRONTEND_URL=http://localhost:3000
GEMINI_API_KEY=your_gemini_api_key
```

---

## Local Development Instructions

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Start PostgreSQL**:
   Make sure a PostgreSQL database is running locally or on a remote host (e.g., Supabase PostgreSQL, RDS, Docker, or local Postgres).
   ```bash
   # Example with Docker:
   docker run --name askly-postgres -e POSTGRES_PASSWORD=password -e POSTGRES_DB=askly_db -p 5432:5432 -d postgres:16
   ```

3. **Run Migrations**:
   The application automatically verifies and runs `db/schema.sql` on startup when connected to `DATABASE_URL`. You can also run it manually using `psql`:
   ```bash
   psql -d askly_db -f db/schema.sql
   ```

4. **Start the Development Server**:
   ```bash
   npm run dev
   ```
   Open `http://localhost:3000` in your browser.

---

## Production Deployment Instructions

1. **Build the Application**:
   ```bash
   npm run build
   ```
   This compiles the Vite React frontend into `dist/` and bundles `server.ts` into `dist/server.cjs`.

2. **Set Production Environment Variables**:
   Configure `NODE_ENV=production`, `DATABASE_URL`, `SESSION_SECRET`, and OAuth credentials on your hosting provider (Render, Railway, Cloud Run, Heroku, AWS, DigitalOcean, etc.).

3. **Start the Production Server**:
   ```bash
   npm start
   ```
