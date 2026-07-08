import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db';
import { z } from 'zod';

const router = express.Router();

// Segédfüggvény az e-mail küldéshez (Relay módszer)
async function sendEmailViaRelay(to: string, subject: string, html: string) {
    if (!process.env.EMAIL_RELAY_URL) {
        console.error('Hiba: EMAIL_RELAY_URL nincs beállítva!');
        return false;
    }
    try {
        const response = await fetch(process.env.EMAIL_RELAY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret: process.env.EMAIL_RELAY_SECRET,
                to,
                subject,
                html
            })
        });
        return response.ok;
    } catch (error) {
        console.error('Email relay hiba:', error);
        return false;
    }
}

const RegisterSchema = z.object({
    username: z.string().min(3, 'A felhasználónév legalább 3 karakter hosszú kell legyen.').max(30),
    email: z.string().email('Érvénytelen e-mail cím.'),
    password: z.string().min(6, 'A jelszónak legalább 6 karakternek kell lennie.'),
    confirmPassword: z.string()
}).refine((data) => data.password === data.confirmPassword, {
    message: "A jelszavak nem egyeznek meg.",
    path: ["confirmPassword"]
});

const LoginSchema = z.object({
    email: z.string().email('Érvénytelen e-mail cím.'),
    password: z.string().min(1, 'A jelszó megadása kötelező.')
});

// --- REGISZTRÁCIÓ ---
router.post('/register', async (req: express.Request, res: express.Response) => {
    try {
        const data = RegisterSchema.parse(req.body);
        const existingUser = await pool.query('SELECT id FROM public.users WHERE email = $1 OR username = $2', [data.email, data.username]);
        if ((existingUser.rowCount ?? 0) > 0) {
            return res.status(400).json({ message: 'Ez az e-mail cím vagy felhasználónév már foglalt.' });
        }
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(data.password, saltRounds);
        const newUser = await pool.query(
            'INSERT INTO public.users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username',
            [data.username, data.email, passwordHash]
        );
        const token = jwt.sign(
            { userId: newUser.rows[0].id, username: newUser.rows[0].username },
            process.env.JWT_SECRET as string,
            { expiresIn: '7d' }
        );
        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });
        res.status(201).json({ status: 'success', message: 'Sikeres regisztráció!' });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ message: (error as any).errors[0].message });
        res.status(500).json({ message: 'Belső szerverhiba történt.' });
    }
});

// --- BEJELENTKEZÉS ---
router.post('/login', async (req: express.Request, res: express.Response) => {
    try {
        const data = LoginSchema.parse(req.body);
        const userResult = await pool.query('SELECT id, username, password_hash FROM public.users WHERE email = $1', [data.email]);
        if ((userResult.rowCount ?? 0) === 0) return res.status(401).json({ message: 'Hibás e-mail cím vagy jelszó.' });
        const user = userResult.rows[0];
        const isValidPassword = await bcrypt.compare(data.password, user.password_hash);
        if (!isValidPassword) return res.status(401).json({ message: 'Hibás e-mail cím vagy jelszó.' });
        const token = jwt.sign({ userId: user.id, username: user.username }, process.env.JWT_SECRET as string, { expiresIn: '7d' });
        res.cookie('auth_token', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict', maxAge: 7 * 24 * 60 * 60 * 1000 });
        res.status(200).json({ status: 'success', message: 'Sikeres bejelentkezés!' });
    } catch (error: any) {
        if (error instanceof z.ZodError) return res.status(400).json({ message: (error as any).errors[0].message });
        res.status(500).json({ message: 'Belső szerverhiba történt.' });
    }
});

// --- ELFELEJTETT JELSZÓ ---
router.post('/forgot-password', async (req: express.Request, res: express.Response) => {
    try {
        const { email } = req.body;
        const userRes = await pool.query('SELECT id, username FROM public.users WHERE email = $1', [email]);
        
        if ((userRes.rowCount ?? 0) === 0) {
            return res.json({ status: 'success', message: 'Ha az e-mail cím létezik, elküldtük a linket.' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000); // 1 óra

        await pool.query(
            'UPDATE public.users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
            [resetToken, expires, email]
        );

        const baseUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
        const resetLink = `${baseUrl}/login?reset_token=${resetToken}`;

        const emailSent = await sendEmailViaRelay(
            email,
            'Jelszó visszaállítása | Worlds Mayhem',
            `<div style="background-color: #010a13; color: #f0e6d2; padding: 30px; font-family: sans-serif; border: 1px solid #c8aa6e; text-align: center;">
                <h2 style="color: #c8aa6e; text-transform: uppercase;">Jelszó visszaállítása</h2>
                <p>Üdvözlünk, ${userRes.rows[0].username}!</p>
                <p>Kattints az alábbi gombra a jelszavad megváltoztatásához:</p>
                <a href="${resetLink}" style="display: inline-block; background-color: #c8aa6e; color: #010a13; padding: 12px 25px; text-decoration: none; font-weight: bold; margin: 20px 0; text-transform: uppercase;">Új jelszó megadása</a>
                <p style="font-size: 11px; color: #666;">A link 1 óráig érvényes.</p>
            </div>`
        );

        if (!emailSent) throw new Error('Email küldési hiba');

        res.json({ status: 'success', message: 'Ha az e-mail cím létezik, elküldtük a linket.' });
    } catch (error: any) {
        console.error(error);
        res.status(500).json({ message: 'Hiba történt az e-mail küldése során.' });
    }
});

// --- JELSZÓ VISSZAÁLLÍTÁSA (RESET) ---
router.post('/reset-password', async (req: express.Request, res: express.Response) => {
    try {
        const { token, newPassword } = req.body;
        const userRes = await pool.query(
            'SELECT id FROM public.users WHERE reset_token = $1 AND reset_token_expires > NOW()',
            [token]
        );
        if ((userRes.rowCount ?? 0) === 0) return res.status(400).json({ message: 'A link lejárt vagy érvénytelen.' });
        const passwordHash = await bcrypt.hash(newPassword, 10);
        await pool.query(
            'UPDATE public.users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
            [passwordHash, userRes.rows[0].id]
        );
        res.json({ status: 'success', message: 'Jelszó sikeresen módosítva!' });
    } catch (error: any) {
        res.status(500).json({ message: 'Hiba a mentés során.' });
    }
});

router.post('/logout', (req: express.Request, res: express.Response) => {
    res.clearCookie('auth_token');
    res.json({ status: 'success' });
});

export default router;