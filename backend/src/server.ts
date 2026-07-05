import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { authRouter } from './routes/auth';
import { requireAuth, AuthRequest } from './middleware/authMiddleware';
import { pool } from './db';
import { setupSockets } from './sockets'; // <--- ÚJ IMPORT

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true }
});

// Inicializáljuk a Socket logikát
setupSockets(io);

// Sablonmotor
app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src/views'));

// Middleware-ek
app.use(express.static(path.join(process.cwd(), 'public')));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
app.use(cookieParser());

// API végpontok
app.use('/api/auth', authRouter);

// --- FRONTEND NÉZETEK ---
app.get('/', (req: express.Request, res: express.Response) => {
  if (req.cookies.auth_token) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', (req: express.Request, res: express.Response) => {
  if (req.cookies.auth_token) return res.redirect('/dashboard');
  res.render('login', { title: 'Belépés | Worlds Mayhem' });
});

app.get('/dashboard', requireAuth, async (req: AuthRequest, res: express.Response) => {
  try {
    const userId = req.user!.userId;
    const userResult = await pool.query('SELECT username, trophies_count FROM public.users WHERE id = $1', [userId]);
    
    if ((userResult.rowCount ?? 0) === 0) {
      res.clearCookie('auth_token');
      return res.redirect('/login');
    }

    res.render('dashboard', { 
      title: 'Központ | Worlds Mayhem',
      userId: userId, // Ezt átadjuk a frontendnek a sockethez!
      username: userResult.rows[0].username,
      trophies: userResult.rows[0].trophies_count
    });
  } catch (error) {
    res.status(500).send('Hiba történt az adatok betöltésekor.');
  }
});

// ÚJ: A Lobbi (Draft Aréna) végpontja
app.get('/lobby/:id', requireAuth, async (req: AuthRequest, res: express.Response) => {
  try {
    const lobbyId = req.params.id;
    const userId = req.user!.userId;

    // Ellenőrizzük, hogy létezik-e a lobbi, és jogosult-e bent lenni
    const lobbyRes = await pool.query('SELECT invite_code FROM public.lobbies WHERE id = $1', [lobbyId]);
    if ((lobbyRes.rowCount ?? 0) === 0) return res.redirect('/dashboard');

    const participantRes = await pool.query('SELECT 1 FROM public.lobby_teams WHERE lobby_id = $1 AND user_id = $2', [lobbyId, userId]);
    if ((participantRes.rowCount ?? 0) === 0) return res.redirect('/dashboard');

    res.render('lobby', { 
      title: 'Draft Aréna | Worlds Mayhem',
      userId: userId,
      lobbyId: lobbyId,
      inviteCode: lobbyRes.rows[0].invite_code
    });
  } catch (error) {
    res.redirect('/dashboard');
  }
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).send('Váratlan belső szerverhiba történt.');
});

const PORT = process.env.PORT || 3333;
httpServer.listen(PORT, () => {
  console.log(`✅ Kiszolgáló elindítva a ${PORT}-es porton.`);
});