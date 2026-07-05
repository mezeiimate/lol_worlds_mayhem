import { Router, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { pool } from '../db';
import { requireAuth, AuthRequest } from '../middleware/authMiddleware';
import crypto from 'crypto';

export const userRouter = Router();
userRouter.use(requireAuth);

const UpdateUsernameSchema = z.object({
  newUsername: z.string().min(3, 'A felhasználónév legalább 3 karakter.').max(50)
});

const UpdatePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'A jelenlegi jelszó megadása kötelező.'),
  newPassword: z.string().min(6, 'Az új jelszó legalább 6 karakter hosszú kell legyen.')
});

userRouter.post('/update-username', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { newUsername } = UpdateUsernameSchema.parse(req.body);
    const userId = req.user!.userId;

    const checkRes = await pool.query('SELECT id FROM public.users WHERE username = $1 AND id != $2', [newUsername, userId]);
    if ((checkRes.rowCount ?? 0) > 0) {
      res.status(400).json({ status: 'error', message: 'Ez a felhasználónév már foglalt.' });
      return;
    }

    await pool.query('UPDATE public.users SET username = $1 WHERE id = $2', [newUsername, userId]);
    res.json({ status: 'success', message: 'A menedzser név sikeresen frissítve.' });
  } catch (error: any) {
    if (error instanceof z.ZodError) { res.status(400).json({ status: 'error', errors: error.issues }); }
    else { res.status(500).json({ status: 'error', message: 'Szerverhiba történt.' }); }
  }
});

userRouter.post('/update-password', async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { currentPassword, newPassword } = UpdatePasswordSchema.parse(req.body);
    const userId = req.user!.userId;

    const userRes = await pool.query('SELECT password_hash FROM public.users WHERE id = $1', [userId]);
    const isMatch = await bcrypt.compare(currentPassword, userRes.rows[0].password_hash);
    
    if (!isMatch) {
      res.status(401).json({ status: 'error', message: 'A jelenlegi jelszó helytelen.' });
      return;
    }

    const salt = await bcrypt.genSalt(12);
    const newHash = await bcrypt.hash(newPassword, salt);

    await pool.query('UPDATE public.users SET password_hash = $1 WHERE id = $2', [newHash, userId]);
    
    // JWT süti azonnali megsemmisítése
    res.clearCookie('auth_token');
    res.json({ status: 'success', message: 'Jelszó sikeresen frissítve. Kérlek jelentkezz be újra!' });
  } catch (error: any) {
    if (error instanceof z.ZodError) { res.status(400).json({ status: 'error', errors: error.issues }); }
    else { res.status(500).json({ status: 'error', message: 'Szerverhiba történt.' }); }
  }
});

userRouter.post('/delete-account', async (req: AuthRequest, res: Response): Promise<void> => {
  const client = await pool.connect();
  try {
    const userId = req.user!.userId;
    const deletedEmail = `deleted_${crypto.randomUUID()}@worldsmayhem.local`;

    await client.query('BEGIN');
    
    // Barátságok végleges törlése
    await client.query('DELETE FROM public.friendships WHERE user_id_1 = $1 OR user_id_2 = $1', [userId]);
    
    // Fiók anonimizálása (megőrzi az ágrajzok és statisztikák stabilitását)
    await client.query(`
        UPDATE public.users 
        SET username = 'Törölt menedzser', 
            email = $1, 
            password_hash = '', 
            is_verified = FALSE, 
            verification_token = NULL 
        WHERE id = $2
    `, [deletedEmail, userId]);

    await client.query('COMMIT');
    
    res.clearCookie('auth_token');
    res.json({ status: 'success', message: 'Fiók sikeresen törölve/anonimizálva.' });
  } catch (error) {
    await client.query('ROLLBACK');
    res.status(500).json({ status: 'error', message: 'Szerverhiba történt a fiók törlésekor.' });
  } finally {
    client.release();
  }
});