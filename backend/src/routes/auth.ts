import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { pool } from '../db';
import crypto from 'crypto';
import nodemailer from 'nodemailer';

export const authRouter = Router();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587', 10),
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const RegisterSchema = z.object({
  email: z.string().email('Érvénytelen e-mail cím.'),
  username: z.string().min(3, 'A felhasználónév legalább 3 karakter.').max(50),
  password: z.string().min(6, 'A jelszó legalább 6 karakter hosszú kell legyen.')
});

const LoginSchema = z.object({
  email: z.string().email('Érvénytelen e-mail cím.'),
  password: z.string().min(1, 'Jelszó megadása kötelező.')
});

authRouter.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = RegisterSchema.parse(req.body);
    
    const userCheck = await pool.query(
      'SELECT id FROM public.users WHERE email = $1 OR username = $2',
      [data.email, data.username]
    );

    if ((userCheck.rowCount ?? 0) > 0) {
      res.status(400).json({ status: 'error', message: 'Ez az e-mail cím vagy felhasználónév már foglalt.' });
      return;
    }

    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(data.password, salt);
    const verificationToken = crypto.randomBytes(32).toString('hex');

    const insertQuery = `
      INSERT INTO public.users (email, username, password_hash, is_verified, verification_token)
      VALUES ($1, $2, $3, FALSE, $4)
      RETURNING id, email, username
    `;
    
    const result = await pool.query(insertQuery, [data.email, data.username, hashedPassword, verificationToken]);
    const newUser = result.rows[0];

    const verificationUrl = `${process.env.APP_URL || 'http://localhost:3333'}/api/auth/verify?token=${verificationToken}`;
    
    await transporter.sendMail({
      from: `"Worlds Mayhem" <${process.env.SMTP_FROM}>`,
      to: newUser.email,
      subject: 'E-mail cím megerősítése',
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #010a13; color: #f0e6d2; padding: 20px; border: 1px solid #c8aa6e; border-radius: 5px; max-width: 600px;">
            <h2 style="color: #c8aa6e; text-transform: uppercase;">Üdvözlünk a Worlds Mayhem rendszerében, ${newUser.username}!</h2>
            <p>A fiókod sikeresen létrejött. A belépéshez kérlek, erősítsd meg az e-mail címedet az alábbi gombra kattintva:</p>
            <a href="${verificationUrl}" style="display: inline-block; background-color: #c8aa6e; color: #010a13; text-decoration: none; padding: 12px 24px; font-weight: bold; margin-top: 15px; border-radius: 3px; text-transform: uppercase; letter-spacing: 1px;">E-mail megerősítése</a>
            <p style="margin-top: 30px; font-size: 11px; color: #64748b; border-top: 1px solid #c8aa6e40; padding-top: 10px;">Ha nem te regisztráltál, kérlek hagyd figyelmen kívül ezt a levelet.</p>
        </div>
      `
    });

    res.status(201).json({ status: 'success', message: 'Sikeres regisztráció. Kérlek, ellenőrizd az e-mail fiókodat a megerősítéshez!' });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ status: 'error', errors: error.issues });
    } else {
      res.status(500).json({ status: 'error', message: 'Szerverhiba történt a regisztráció során.' });
    }
  }
});

authRouter.get('/verify', async (req: Request, res: Response): Promise<void> => {
    try {
        const token = req.query.token as string;
        if (!token) {
            res.status(400).send('Érvénytelen vagy hiányzó azonosító (token).');
            return;
        }

        const result = await pool.query('UPDATE public.users SET is_verified = TRUE, verification_token = NULL WHERE verification_token = $1 RETURNING id', [token]);
        
        if ((result.rowCount ?? 0) === 0) {
            res.status(400).send('Érvénytelen vagy már felhasznált token.');
            return;
        }

        res.redirect('/login?verified=true');
    } catch (error) {
        res.status(500).send('Szerverhiba történt a megerősítés során.');
    }
});

authRouter.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const data = LoginSchema.parse(req.body);
    
    const result = await pool.query(
      'SELECT id, email, username, password_hash, is_verified FROM public.users WHERE email = $1',
      [data.email]
    );

    if ((result.rowCount ?? 0) === 0) {
      res.status(401).json({ status: 'error', message: 'Hibás e-mail cím vagy jelszó.' });
      return;
    }

    const user = result.rows[0];

    if (!user.is_verified) {
        res.status(403).json({ status: 'error', message: 'Kérlek, először erősítsd meg az e-mail címedet a kiküldött levélben!' });
        return;
    }

    const isMatch = await bcrypt.compare(data.password, user.password_hash);
    if (!isMatch) {
      res.status(401).json({ status: 'error', message: 'Hibás e-mail cím vagy jelszó.' });
      return;
    }

    const token = jwt.sign(
      { userId: user.id, username: user.username },
      process.env.JWT_SECRET || 'fallback_secret',
      { expiresIn: '24h' }
    );

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.json({ 
      status: 'success', 
      data: { id: user.id, email: user.email, username: user.username } 
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ status: 'error', errors: error.issues });
    } else {
      res.status(500).json({ status: 'error', message: 'Szerverhiba történt a bejelentkezés során.' });
    }
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('auth_token');
  res.json({ status: 'success' });
});