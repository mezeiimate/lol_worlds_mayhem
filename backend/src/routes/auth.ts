import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db';

export const authRouter = Router();

// Zod sémák a bemenet validálására
const RegisterSchema = z.object({
  email: z.string().email('Érvénytelen e-mail cím.'),
  username: z.string().min(3, 'A felhasználónév legalább 3 karakter.').max(50),
  password: z.string().min(6, 'A jelszó legalább 6 karakter hosszú kell legyen.')
});

const LoginSchema = z.object({
  email: z.string().email('Érvénytelen e-mail cím.'),
  password: z.string().min(1, 'Jelszó megadása kötelező.')
});

// --- REGISZTRÁCIÓ ---
authRouter.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = RegisterSchema.parse(req.body);
    
    // Létezik már ez az e-mail vagy felhasználónév?
    const userCheck = await pool.query(
      'SELECT id FROM public.users WHERE email = $1 OR username = $2',
      [data.email, data.username]
    );

    if ((userCheck.rowCount ?? 0) > 0) {
      res.status(409).json({ status: 'error', message: 'Az e-mail cím vagy felhasználónév már foglalt.' });
      return;
    }

    // Jelszó hashelése bcrypt-tel (Salt rounds: 10)
    const saltRounds = 10;
    const passwordHash = await bcrypt.hash(data.password, saltRounds);

    // Felhasználó mentése
    const result = await pool.query(
      'INSERT INTO public.users (email, username, password_hash) VALUES ($1, $2, $3) RETURNING id, email, username',
      [data.email, data.username, passwordHash]
    );

    res.status(201).json({ status: 'success', data: result.rows[0] });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ status: 'error', errors: error.issues });
    } else {
      console.error('[Auth Error] Register:', error);
      res.status(500).json({ status: 'error', message: 'Belső szerverhiba.' });
    }
  }
});

// --- BEJELENTKEZÉS ---
authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = LoginSchema.parse(req.body);

    const result = await pool.query(
      'SELECT id, email, username, password_hash FROM public.users WHERE email = $1',
      [data.email]
    );

    if ((result.rowCount ?? 0) === 0) {
      res.status(401).json({ status: 'error', message: 'Hibás e-mail cím vagy jelszó.' });
      return;
    }

    const user = result.rows[0];

    // Jelszó ellenőrzése
    const isMatch = await bcrypt.compare(data.password, user.password_hash);
    if (!isMatch) {
      res.status(401).json({ status: 'error', message: 'Hibás e-mail cím vagy jelszó.' });
      return;
    }

    // JWT Token generálása
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    // Token elküldése HttpOnly sütiként
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 1 nap
    });

    res.json({ 
      status: 'success', 
      data: { id: user.id, email: user.email, username: user.username } 
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ status: 'error', errors: error.issues });
    } else {
      console.error('[Auth Error] Login:', error);
      res.status(500).json({ status: 'error', message: 'Belső szerverhiba.' });
    }
  }
});

// --- KIJELENTKEZÉS ---
authRouter.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });
  res.json({ status: 'success', message: 'Sikeres kijelentkezés.' });
});