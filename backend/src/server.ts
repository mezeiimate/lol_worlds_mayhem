import dns from 'dns';
// A hálózati hiba (ENETUNREACH) elkerülése érdekében kényszerítjük az IPv4 használatát
dns.setDefaultResultOrder('ipv4first');

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import authRouter from './routes/auth';
import { userRouter } from './routes/user';
import { requireAuth, AuthRequest } from './middleware/authMiddleware';
import { pool } from './db';
import { setupSockets } from './sockets';

dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, credentials: true }
});

setupSockets(io);
app.set('io', io);

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'src/views'));

app.use(express.static(path.join(process.cwd(), 'public')));
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 
app.use(cookieParser());

app.use('/api/auth', authRouter);
app.use('/api/user', userRouter);

const friendsRouter = express.Router();
friendsRouter.use(requireAuth);

friendsRouter.post('/request', async (req: AuthRequest, res: express.Response) => {
  try {
    const targetUserId = req.body.targetUserId;
    const userId = req.user!.userId;
    if (userId === targetUserId) { res.status(400).json({ error: 'Saját magadat nem jelölheted barátnak.' }); return; }
    const id1 = userId < targetUserId ? userId : targetUserId; const id2 = userId < targetUserId ? targetUserId : userId;
    await pool.query(`INSERT INTO public.friendships (user_id_1, user_id_2, status, action_user_id) VALUES ($1, $2, 'PENDING', $3) ON CONFLICT (user_id_1, user_id_2) DO NOTHING`, [id1, id2, userId]);
    const socketIo = req.app.get('io') as Server; if (socketIo) { socketIo.to(targetUserId).emit('friend_update'); socketIo.to(userId).emit('friend_update'); }
    res.json({ status: 'success' });
  } catch (error) { res.status(400).json({ error: 'Érvénytelen kérés.' }); }
});

friendsRouter.post('/accept', async (req: AuthRequest, res: express.Response) => {
  try {
    const targetUserId = req.body.targetUserId; const userId = req.user!.userId;
    const id1 = userId < targetUserId ? userId : targetUserId; const id2 = userId < targetUserId ? targetUserId : userId;
    await pool.query(`UPDATE public.friendships SET status = 'ACCEPTED' WHERE user_id_1 = $1 AND user_id_2 = $2 AND status = 'PENDING' AND action_user_id != $3`, [id1, id2, userId]);
    const socketIo = req.app.get('io') as Server; if (socketIo) { socketIo.to(targetUserId).emit('friend_update'); socketIo.to(userId).emit('friend_update'); }
    res.json({ status: 'success' });
  } catch (error) { res.status(400).json({ error: 'Érvénytelen kérés.' }); }
});

friendsRouter.post('/remove', async (req: AuthRequest, res: express.Response) => {
  try {
    const targetUserId = req.body.targetUserId; const userId = req.user!.userId;
    const id1 = userId < targetUserId ? userId : targetUserId; const id2 = userId < targetUserId ? targetUserId : userId;
    await pool.query(`DELETE FROM public.friendships WHERE user_id_1 = $1 AND user_id_2 = $2`, [id1, id2]);
    const socketIo = req.app.get('io') as Server; if (socketIo) { socketIo.to(targetUserId).emit('friend_update'); socketIo.to(userId).emit('friend_update'); }
    res.json({ status: 'success' });
  } catch (error) { res.status(400).json({ error: 'Érvénytelen kérés.' }); }
});

friendsRouter.get('/search', async (req: AuthRequest, res: express.Response) => {
  try {
    const q = req.query.q as string; if (!q || q.length < 3) { res.json([]); return; }
    const result = await pool.query(`SELECT id, username, trophies_count FROM public.users WHERE username ILIKE $1 AND id != $2 LIMIT 10`, [`%${q}%`, req.user!.userId]);
    res.json(result.rows);
  } catch (error) { res.status(400).json({ error: 'Hiba a keresés során.' }); }
});

friendsRouter.get('/all', async (req: AuthRequest, res: express.Response) => {
  try {
    const userId = req.user!.userId;
    const friendsRes = await pool.query(`SELECT f.id as friendship_id, f.status, f.action_user_id, u.id as friend_id, u.username as friend_name, u.trophies_count FROM public.friendships f JOIN public.users u ON (u.id = f.user_id_1 OR u.id = f.user_id_2) WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1) AND u.id != $1`, [userId]);
    res.json(friendsRes.rows);
  } catch (error) { res.status(500).json({ error: 'Hiba.' }); }
});

friendsRouter.get('/list', async (req: AuthRequest, res: express.Response) => {
  try {
    const userId = req.user!.userId;
    const result = await pool.query(`SELECT u.id, u.username FROM public.friendships f JOIN public.users u ON (u.id = f.user_id_1 OR u.id = f.user_id_2) WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1) AND u.id != $1 AND f.status = 'ACCEPTED'`, [userId]);
    res.json(result.rows);
  } catch (error) { res.status(500).json({ error: 'Hiba.' }); }
});

app.use('/api/friends', friendsRouter);

app.get('/', (req: express.Request, res: express.Response) => {
  if (req.cookies.auth_token) return res.redirect('/dashboard');
  res.redirect('/login');
});

app.get('/login', (req: express.Request, res: express.Response) => {
  if (req.cookies.auth_token) return res.redirect('/dashboard');
  res.render('login', { title: 'Belépés | Worlds Mayhem' });
});

app.get('/profile', requireAuth, async (req: AuthRequest, res: express.Response) => {
    try {
        const userResult = await pool.query('SELECT username, email FROM public.users WHERE id = $1', [req.user!.userId]);
        if ((userResult.rowCount ?? 0) === 0) return res.redirect('/login');
        
        res.render('profile', {
            title: 'Fiók beállításai | Worlds Mayhem',
            username: userResult.rows[0].username,
            email: userResult.rows[0].email
        });
    } catch (error) { res.redirect('/dashboard'); }
});

app.get('/dashboard', requireAuth, async (req: AuthRequest, res: express.Response) => {
  try {
    const userId = req.user!.userId;
    const userResult = await pool.query('SELECT username, trophies_count FROM public.users WHERE id = $1', [userId]);
    if ((userResult.rowCount ?? 0) === 0) { res.clearCookie('auth_token'); return res.redirect('/login'); }

    const leaderboardRes = await pool.query('SELECT username, trophies_count FROM public.users ORDER BY trophies_count DESC LIMIT 10');
    const historyRes = await pool.query('SELECT lobby_name, final_position, roster_summary, played_at FROM public.match_history WHERE user_id = $1 ORDER BY played_at DESC LIMIT 5', [userId]);
    const friendsRes = await pool.query(`SELECT f.id as friendship_id, f.status, f.action_user_id, u.id as friend_id, u.username as friend_name, u.trophies_count FROM public.friendships f JOIN public.users u ON (u.id = f.user_id_1 OR u.id = f.user_id_2) WHERE (f.user_id_1 = $1 OR f.user_id_2 = $1) AND u.id != $1`, [userId]);

    res.render('dashboard', { 
      title: 'Központ | Worlds Mayhem', userId: userId, username: userResult.rows[0].username, trophies: userResult.rows[0].trophies_count, leaderboard: leaderboardRes.rows, matchHistory: historyRes.rows, friends: friendsRes.rows
    });
  } catch (error) { res.status(500).send('Hiba történt az adatok betöltésekor.'); }
});

app.get('/lobby/:id', requireAuth, async (req: AuthRequest, res: express.Response) => {
  try {
    const lobbyId = req.params.id; const userId = req.user!.userId;
    const lobbyRes = await pool.query('SELECT invite_code FROM public.lobbies WHERE id = $1', [lobbyId]);
    if ((lobbyRes.rowCount ?? 0) === 0) return res.redirect('/dashboard');
    const participantRes = await pool.query('SELECT 1 FROM public.lobby_teams WHERE lobby_id = $1 AND user_id = $2', [lobbyId, userId]);
    if ((participantRes.rowCount ?? 0) === 0) return res.redirect('/dashboard');
    res.render('lobby', { title: 'Draft aréna | Worlds Mayhem', userId: userId, lobbyId: lobbyId, inviteCode: lobbyRes.rows[0].invite_code });
  } catch (error) { res.redirect('/dashboard'); }
});

app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  res.status(500).send('Váratlan belső szerverhiba történt.');
});

const PORT = process.env.PORT || 3333;
httpServer.listen(PORT, () => {
  console.log(`✅ Kiszolgáló elindítva a ${PORT}-es porton.`);
});