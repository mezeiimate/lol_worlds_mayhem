import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { pool } from '../db';
import { z } from 'zod';

const router = express.Router();

// Közös e-mail küldő függvény (Relay)
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

// Szigorú validációs sémák
const RegisterSchema = z.object({
    username: z.string().min(3, 'A felhasználónév legalább 3 karakter hosszú kell legyen.').max(30),
    email: z.string().email('Érvénytelen e-mail cím.'),
    password: z.string().min(6, 'A jelszónak legalább 6 karakternek kell lennie.'),
    confirmPassword: z.string()
}).refine((data) => data.password === data.confirmPassword, {
    message: "A jelszavak nem egyeznek meg.",
    path: ["confirmPassword"]
});

// Belépés felhasználónévvel!
const LoginSchema = z.object({
    username: z.string().min(1, 'A felhasználónév megadása kötelező.'),
    password: z.string().min(1, 'A jelszó megadása kötelező.')
});

const ForgotPasswordSchema = z.object({
    email: z.string().email('Érvénytelen e-mail cím.')
});

// Resetnél is ellenőrizzük a megerősítést
const ResetPasswordSchema = z.object({
    token: z.string(),
    newPassword: z.string().min(6, 'Az új jelszónak legalább 6 karakternek kell lennie.'),
    confirmNewPassword: z.string()
}).refine((data) => data.newPassword === data.confirmNewPassword, {
    message: "Az új jelszavak nem egyeznek meg.",
    path: ["confirmNewPassword"]
});

// --- REGISZTRÁCIÓ (E-MAIL KÜLDÉSSEL, NEM LÉPTET BE) ---
router.post('/register', async (req: express.Request, res: express.Response) => {
    try {
        const data = RegisterSchema.parse(req.body);
        
        const existingUser = await pool.query('SELECT id FROM public.users WHERE email = $1 OR username = $2', [data.email, data.username]);
        if ((existingUser.rowCount ?? 0) > 0) {
            return res.status(400).json({ message: 'Ez az e-mail cím vagy felhasználónév már foglalt.' });
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(data.password, saltRounds);
        
        const verificationToken = crypto.randomBytes(32).toString('hex');

        // is_verified = false beállítása alapértelmezetten
        await pool.query(
            'INSERT INTO public.users (username, email, password_hash, is_verified, verification_token) VALUES ($1, $2, $3, false, $4)',
            [data.username, data.email, passwordHash, verificationToken]
        );

        // Biztonságos Base URL generálás dupla perjel nélkül
        const baseUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
        const verifyLink = `${baseUrl}/api/auth/verify?token=${verificationToken}`;

        const emailSent = await sendEmailViaRelay(
            data.email,
            'Fiók megerősítése | Worlds Mayhem',
            `<div style="background-color: #010a13; color: #f0e6d2; padding: 30px; font-family: sans-serif; border: 1px solid #c8aa6e; text-align: center;">
                <h2 style="color: #c8aa6e; text-transform: uppercase;">Üdv a ligában, ${data.username}!</h2>
                <p>A fiókod sikeresen létrejött. A belépéshez kérlek erősítsd meg az e-mail címedet az alábbi gombra kattintva:</p>
                <a href="${verifyLink}" style="display: inline-block; background-color: #c8aa6e; color: #010a13; padding: 12px 25px; text-decoration: none; font-weight: bold; margin: 20px 0; text-transform: uppercase;">Fiók hitelesítése</a>
                <p style="font-size: 11px; color: #666;">Ha nem te regisztráltál, hagyd figyelmen kívül ezt a levelet.</p>
            </div>`
        );

        if (!emailSent) {
            console.error("Nem sikerült elküldeni a megerősítő e-mailt.");
        }

        // Nem adunk sütit, csak sikert jelzünk
        res.status(201).json({ status: 'success', message: 'Sikeres regisztráció! Kérlek, nézd meg az e-mail fiókodat a hitelesítéshez.' });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ message: (error as any).errors[0].message });
        }
        res.status(500).json({ message: 'Belső szerverhiba történt.' });
    }
});

// --- E-MAIL HITELESÍTÉS VÉGPONT (LINKRŐL ÉRKEZVE) ---
router.get('/verify', async (req: express.Request, res: express.Response) => {
    try {
        const token = req.query.token as string;
        if (!token) return res.status(400).send('Érvénytelen link.');

        const userRes = await pool.query('SELECT id FROM public.users WHERE verification_token = $1', [token]);
        if ((userRes.rowCount ?? 0) === 0) {
            return res.status(400).send('A hitelesítő link lejárt vagy érvénytelen.');
        }

        await pool.query('UPDATE public.users SET is_verified = true, verification_token = NULL WHERE id = $1', [userRes.rows[0].id]);
        
        // Visszairányítás a loginra egy paraméterrel
        const baseUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
        res.redirect(`${baseUrl}/login?verified=true`);
    } catch (error) {
        res.status(500).send('Belső szerverhiba.');
    }
});

// --- BEJELENTKEZÉS (FELHASZNÁLÓNÉVVEL ÉS HITELESÍTÉS ELLENŐRZÉSSEL) ---
router.post('/login', async (req: express.Request, res: express.Response) => {
    try {
        const data = LoginSchema.parse(req.body);

        const userResult = await pool.query('SELECT id, username, password_hash, is_verified FROM public.users WHERE username = $1', [data.username]);
        if ((userResult.rowCount ?? 0) === 0) {
            return res.status(401).json({ message: 'Hibás felhasználónév vagy jelszó.' });
        }

        const user = userResult.rows[0];
        
        if (!user.is_verified) {
            return res.status(403).json({ message: 'A fiókod még nincs megerősítve. Kérlek, ellenőrizd az e-mailjeidet!' });
        }

        const isValidPassword = await bcrypt.compare(data.password, user.password_hash);
        if (!isValidPassword) {
            return res.status(401).json({ message: 'Hibás felhasználónév vagy jelszó.' });
        }

        const token = jwt.sign(
            { userId: user.id, username: user.username },
            process.env.JWT_SECRET as string,
            { expiresIn: '7d' }
        );

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 7 * 24 * 60 * 60 * 1000
        });

        res.status(200).json({ status: 'success', message: 'Sikeres bejelentkezés!' });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ message: (error as any).errors[0].message });
        }
        res.status(500).json({ message: 'Belső szerverhiba történt.' });
    }
});

// --- ELFELEJTETT JELSZÓ ---
router.post('/forgot-password', async (req: express.Request, res: express.Response) => {
    try {
        const data = ForgotPasswordSchema.parse(req.body);
        
        const userRes = await pool.query('SELECT id, username FROM public.users WHERE email = $1', [data.email]);
        if ((userRes.rowCount ?? 0) === 0) {
            return res.json({ status: 'success', message: 'Ha az e-mail cím létezik a rendszerünkben, elküldtük a visszaállító linket.' });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const expires = new Date(Date.now() + 3600000); // 1 óra érvényesség

        await pool.query(
            'UPDATE public.users SET reset_token = $1, reset_token_expires = $2 WHERE email = $3',
            [resetToken, expires, data.email]
        );

        const baseUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
        const resetLink = `${baseUrl}/login?reset_token=${resetToken}`;

        const emailSent = await sendEmailViaRelay(
            data.email,
            'Jelszó visszaállítása | Worlds Mayhem',
            `<div style="background-color: #010a13; color: #f0e6d2; padding: 30px; font-family: sans-serif; border: 1px solid #c8aa6e; text-align: center;">
                <h2 style="color: #c8aa6e; text-transform: uppercase;">Jelszó visszaállítása</h2>
                <p>Üdvözlünk, ${userRes.rows[0].username}!</p>
                <p>Egy kérés érkezett a Worlds Mayhem fiókod jelszavának visszaállítására.</p>
                <p>Kattints az alábbi gombra az új jelszó megadásához:</p>
                <a href="${resetLink}" style="display: inline-block; background-color: #c8aa6e; color: #010a13; padding: 12px 25px; text-decoration: none; font-weight: bold; margin: 20px 0; text-transform: uppercase;">Új jelszó megadása</a>
                <p style="font-size: 11px; color: #888;">Ez a link 1 órán belül lejár. Ha nem te kérted a visszaállítást, hagyd figyelmen kívül ezt az e-mailt.</p>
            </div>`
        );

        if (!emailSent) throw new Error('Email Relay Hiba');

        res.json({ status: 'success', message: 'Ha az e-mail cím létezik a rendszerünkben, elküldtük a visszaállító linket.' });
    } catch (error: any) {
        res.status(500).json({ message: 'Hiba történt az e-mail küldése során.' });
    }
});

// --- JELSZÓ VISSZAÁLLÍTÁSA (ÚJ JELSZÓ BEÁLLÍTÁSA MEGERŐSÍTÉSSEL) ---
router.post('/reset-password', async (req: express.Request, res: express.Response) => {
    try {
        const data = ResetPasswordSchema.parse(req.body);

        const userRes = await pool.query(
            'SELECT id FROM public.users WHERE reset_token = $1 AND reset_token_expires > NOW()',
            [data.token]
        );

        if ((userRes.rowCount ?? 0) === 0) {
            return res.status(400).json({ message: 'A visszaállító link érvénytelen vagy lejárt.' });
        }

        const passwordHash = await bcrypt.hash(data.newPassword, 10);

        await pool.query(
            'UPDATE public.users SET password_hash = $1, reset_token = NULL, reset_token_expires = NULL WHERE id = $2',
            [passwordHash, userRes.rows[0].id]
        );

        res.json({ status: 'success', message: 'A jelszavad sikeresen megváltozott! Kérlek lépj be.' });
    } catch (error: any) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({ message: (error as any).errors[0].message });
        }
        res.status(500).json({ message: 'Belső szerverhiba.' });
    }
});

// --- KIJELENTKEZÉS ---
router.post('/logout', (req: express.Request, res: express.Response) => {
    res.clearCookie('auth_token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict'
    });
    res.json({ status: 'success' });
});

export default router;