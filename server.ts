import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import passport from 'passport';
import { GoogleGenAI } from '@google/genai';
import { createServer as createViteServer } from 'vite';

import { initDatabase, getPool, isDbConnected, saveChatMessage } from './db/index.js';
import { configurePassport } from './passport/index.js';
import { authRouter } from './routes/auth.js';
import { chatRouter } from './routes/chat.js';
import { selaApiRouter } from './routes/selaApi.js';
import { optionalAuth, AuthenticatedRequest } from './middleware/auth.js';
import { generateFollowUpSuggestions, getFallbackSuggestions } from './services/suggestions.js';
import { buildSystemInstruction, isVerifiedAdmin } from './services/persona.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

  // Trust first proxy hop (Cloud Run, load balancers, reverse proxies)
  app.set('trust proxy', 1);

  // Initialize PostgreSQL / Database connection
  await initDatabase();

  // Basic middleware
  app.use(
    cors({
      origin: process.env.FRONTEND_URL || true,
      credentials: true,
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Session store setup: PostgreSQL session store (connect-pg-simple) or MemoryStore
  const PgSession = connectPgSimple(session);
  const sessionSecret =
    process.env.SESSION_SECRET || 'askly_session_secure_secret_key_change_in_prod';

  let sessionStore: session.Store;
  const pool = getPool();

  if (isDbConnected() && pool) {
    sessionStore = new PgSession({
      pool,
      tableName: 'session',
      createTableIfMissing: true,
    });
    console.log('[Session] Using PostgreSQL-backed session store.');
  } else {
    sessionStore = new session.MemoryStore();
    console.log('[Session] Using in-memory session store (connect PostgreSQL via DATABASE_URL for production).');
  }

  const isProduction = process.env.NODE_ENV === 'production';

  app.use(
    session({
      store: sessionStore,
      name: 'askly.sid',
      secret: sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? 'none' : 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      },
    })
  );

  // Initialize Passport & Strategies
  configurePassport();
  app.use(passport.initialize());
  app.use(passport.session());

  // Mount API Routes
  app.use('/api/auth', authRouter);
  app.use('/api/chat', chatRouter);
  app.use('/', selaApiRouter);

  // Initialize Gemini API client
  const getGeminiClient = () => {
    const apiKey =
      process.env.GEMINI_API_KEY ||
      'AQ.Ab8RN6JEvJkxzIfCgO7oXcGbb98Sdjys1i1p_KJJOUqrRDi26g';
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY is not configured in the environment.');
    }
    return new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  };

  // API Health Check
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      database: isDbConnected() ? 'postgresql' : 'in-memory',
      hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    });
  });

  // Supported Gemini fast text model candidates
  const CANDIDATE_MODELS = [
    'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-flash-latest',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
  ];

  // Multilingual Q&A endpoint: Streaming with SSE
  app.post('/api/ask-stream', optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { question, history = [], mode = 'Sela Fast', languagePreference = 'auto' } = req.body;

      if (!question || typeof question !== 'string') {
        return res.status(400).json({ error: 'Question is required.' });
      }

      const userId = req.user?.id;
      if (userId) {
        // Save user message to PostgreSQL
        try {
          await saveChatMessage({ userId, role: 'user', message: question.trim() });
        } catch (dbErr) {
          console.warn('[DB Stream Save Error]:', dbErr);
        }
      }

      let ai;
      try {
        ai = getGeminiClient();
      } catch (err: any) {
        console.error('Gemini init error in streaming route:', err);
        return res.status(500).json({
          error: 'Gemini API is not configured. Please ensure GEMINI_API_KEY is set in Settings > Secrets.',
        });
      }

      // Configure SSE response headers
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

      // Include compact conversation context (last 6 turns)
      if (Array.isArray(history) && history.length > 0) {
        const recentHistory = history.slice(-6);
        for (const item of recentHistory) {
          if (item && item.content) {
            const role = item.role === 'model' || item.role === 'assistant' ? 'model' : 'user';
            contents.push({
              role,
              parts: [{ text: item.content }],
            });
          }
        }
      }

      let currentPrompt = question.trim();
      if (languagePreference && languagePreference !== 'auto') {
        currentPrompt += `\n[User requested language: ${languagePreference}]`;
      }

      contents.push({
        role: 'user',
        parts: [{ text: currentPrompt }],
      });

      const systemInstruction = buildSystemInstruction(mode, req.user);
      let answerText = '';
      let lastStreamError: any = null;

      for (const modelName of CANDIDATE_MODELS) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents,
            config: {
              systemInstruction,
              temperature: 0.6,
            },
          });

          if (response && response.text) {
            answerText = response.text;
            break;
          }
        } catch (modelErr: any) {
          lastStreamError = modelErr;
          console.log(`[Askly Stream] Switching from ${modelName} (status ${modelErr?.status || 'retry'})`);
          continue;
        }
      }

      if (!answerText && (lastStreamError?.status === 429 || lastStreamError?.status === 503)) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        for (const retryModel of CANDIDATE_MODELS.slice(0, 3)) {
          try {
            const retryRes = await ai.models.generateContent({
              model: retryModel,
              contents,
              config: {
                systemInstruction,
                temperature: 0.6,
              },
            });
            if (retryRes && retryRes.text) {
              answerText = retryRes.text;
              break;
            }
          } catch {
            continue;
          }
        }
      }

      if (answerText) {
        // Save AI response to DB for authenticated user
        if (userId) {
          try {
            await saveChatMessage({ userId, role: 'model', message: answerText });
          } catch (dbErr) {
            console.warn('[DB Stream Save AI Error]:', dbErr);
          }
        }

        const words = answerText.match(/\S+\s*/g) || [answerText];
        for (const word of words) {
          res.write(`data: ${JSON.stringify({ text: word })}\n\n`);
          await new Promise((resolve) => setTimeout(resolve, 12));
        }

        // Generate 3 contextual follow-up suggestions
        let suggestions: string[] = [];
        try {
          suggestions = await generateFollowUpSuggestions(ai, answerText, question);
        } catch {
          suggestions = getFallbackSuggestions(answerText, question);
        }

        res.write(`data: ${JSON.stringify({ done: true, suggestions })}\n\n`);
        res.end();
        return;
      }

      const errStr = JSON.stringify(lastStreamError || '');
      let errorMsg = 'Unable to generate response. Please try again.';
      if (errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('high demand')) {
        errorMsg = 'The AI service is experiencing high demand right now. Please click Retry in a moment.';
      } else if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
        errorMsg = 'Too many requests at this moment. Please wait a few seconds and click Retry.';
      }

      res.write(`data: ${JSON.stringify({ error: errorMsg, done: true })}\n\n`);
      res.end();
    } catch (error: any) {
      console.log('[Askly Stream Notice]:', error?.message || 'Stream finished');
      if (!res.headersSent) {
        return res.status(500).json({ error: error?.message || 'Streaming failed.' });
      }
      res.write(`data: ${JSON.stringify({ error: 'Stream interrupted.', done: true })}\n\n`);
      res.end();
    }
  });

  // REST endpoint for non-streaming
  app.post('/api/ask', optionalAuth, async (req: AuthenticatedRequest, res) => {
    try {
      const { question, history = [], languagePreference, mode = 'Sela Fast' } = req.body;

      if (!question || typeof question !== 'string' || question.trim() === '') {
        return res.status(400).json({
          error: 'Please provide a valid question.',
        });
      }

      const userId = req.user?.id;
      if (userId) {
        try {
          await saveChatMessage({ userId, role: 'user', message: question.trim() });
        } catch (dbErr) {
          console.warn('[DB REST Save Error]:', dbErr);
        }
      }

      let ai;
      try {
        ai = getGeminiClient();
      } catch (err: any) {
        console.error('Gemini init error in standard route:', err);
        return res.status(500).json({
          error: 'Gemini API is not ready. Please make sure GEMINI_API_KEY is configured in Settings > Secrets.',
        });
      }

      const systemInstruction = buildSystemInstruction(mode, req.user);
      const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

      if (Array.isArray(history)) {
        for (const item of history) {
          if (item && item.content && typeof item.content === 'string') {
            const role = item.role === 'model' || item.role === 'assistant' ? 'model' : 'user';
            contents.push({
              role,
              parts: [{ text: item.content }],
            });
          }
        }
      }

      let currentPrompt = question.trim();
      if (languagePreference && languagePreference !== 'auto') {
        currentPrompt += `\n[User requested language: ${languagePreference}]`;
      }

      contents.push({
        role: 'user',
        parts: [{ text: currentPrompt }],
      });

      let lastError: any = null;
      let answer = '';

      for (const modelName of CANDIDATE_MODELS) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents,
            config: {
              systemInstruction,
              temperature: 0.6,
            },
          });

          if (response && response.text) {
            answer = response.text;
            break;
          }
        } catch (modelErr: any) {
          lastError = modelErr;
          console.log(`[Askly REST] Switching from ${modelName} (status ${modelErr?.status || 'retry'})`);
          continue;
        }
      }

      if (!answer && (lastError?.status === 429 || lastError?.status === 503)) {
        await new Promise((resolve) => setTimeout(resolve, 1200));
        for (const retryModel of CANDIDATE_MODELS.slice(0, 3)) {
          try {
            const retryRes = await ai.models.generateContent({
              model: retryModel,
              contents,
              config: {
                systemInstruction,
                temperature: 0.6,
              },
            });
            if (retryRes && retryRes.text) {
              answer = retryRes.text;
              break;
            }
          } catch {
            continue;
          }
        }
      }

      if (!answer) {
        if (lastError) throw lastError;
        throw new Error('Unable to generate answer from any model candidate.');
      }

      if (userId) {
        try {
          await saveChatMessage({ userId, role: 'model', message: answer });
        } catch (dbErr) {
          console.warn('[DB REST Save AI Error]:', dbErr);
        }
      }

      let suggestions: string[] = [];
      try {
        suggestions = await generateFollowUpSuggestions(ai, answer, question);
      } catch {
        suggestions = getFallbackSuggestions(answer, question);
      }

      return res.json({
        answer,
        suggestions,
      });
    } catch (error: any) {
      const errMsg = error?.message || '';
      const errStr = JSON.stringify(error || '');

      let userFriendlyError = 'Something went wrong while processing your question. Please click Retry.';

      if (errStr.includes('503') || errStr.includes('UNAVAILABLE') || errStr.includes('high demand')) {
        userFriendlyError = 'The AI service is experiencing high demand right now. Please click Retry in a moment.';
      } else if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED')) {
        userFriendlyError = 'Too many requests at this moment. Please wait a few seconds and click Retry.';
      } else if (errMsg.includes('API_KEY') || errStr.includes('API_KEY')) {
        userFriendlyError = 'Unable to connect to AI service. Please verify the Gemini API configuration in Settings > Secrets.';
      }

      console.log('[Askly REST Notice]:', userFriendlyError);

      return res.status(500).json({
        error: userFriendlyError,
      });
    }
  });

  // Dedicated endpoint to get follow-up suggestions for any response
  app.post('/api/chat/suggestions', async (req, res) => {
    try {
      const { lastResponse, question } = req.body;
      if (!lastResponse || typeof lastResponse !== 'string') {
        return res.json({ suggestions: [] });
      }

      try {
        const ai = getGeminiClient();
        const suggestions = await generateFollowUpSuggestions(ai, lastResponse, question || '');
        return res.json({ suggestions });
      } catch {
        const fallback = getFallbackSuggestions(lastResponse, question || '');
        return res.json({ suggestions: fallback });
      }
    } catch {
      return res.json({
        suggestions: [
          'Can you explain this in more detail?',
          'Can you give an example?',
          'What are the next steps?',
        ],
      });
    }
  });

  // Setup Vite middleware in dev or static files in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Askly server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
