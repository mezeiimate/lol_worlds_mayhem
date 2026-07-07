import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../db';

const router = Router();

// Dinamikus HTML generátor a szép Hextech megerősítő / hiba oldalhoz
const getHextechHtml = (title: string, headline: string, message: string, isError: boolean = false) => {
    const color = isError ? 'ef4444' : 'c8aa6e';
    const colorClass = isError ? 'text-red-500' : 'text-[#c8aa6e]';
    const icon = isError 
        ? `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>`
        : `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"></path>`;
        
    return `
    <!DOCTYPE html>
    <html lang="hu">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>${title} | Worlds Mayhem</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <style>
            @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@400;600;700&display=swap');
            body { background-color: #010a13; color: #f0e6d2; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; }
            .esport-font { font-family: 'Oswald', sans-serif; text-transform: uppercase; }
            .hex-border { border: 1px solid #${color}; }
        </style>
    </head>
    <body class="min-h-screen flex items-center justify-center p-4 relative overflow-hidden">
        <div class="absolute top-[-15%] left-[-10%] w-[500px] h-[500px] bg-[#${color}]/10 rounded-full blur-[100px] pointer-events-none"></div>
        <div class="absolute bottom-[-15%] right-[-10%] w-[500px] h-[500px] bg-[#091428] rounded-full blur-[100px] pointer-events-none"></div>
        
        <div class="max-w-md w-full bg-[#091428] p-1 hex-border shadow-[0_0_50px_rgba(200,170,110,0.15)] relative z-10">
            <div class="bg-[#010a13] p-10 text-center border border-[#${color}]/20">
                <svg class="w-16 h-16 mx-auto mb-6 ${colorClass}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    ${icon}
                </svg>
                <h1 class="text-3xl text-transparent bg-clip-text bg-gradient-to-r from-[#${color}] to-[#f0e6d2] tracking-widest font-black esport-font mb-4">${headline}</h1>
                <p class="text-[#f0e6d2] mb-8 font-semibold">${message}</p>
                <div class="border-t border-[#${color}]/30 pt-6">
                    <p class="${colorClass} text-sm uppercase tracking-widest font-bold animate-pulse">Ezt az ablakot most már bezárhatod.</p>
                </div>
            </div>
        </div>
    </body>
    </html>`;
};

const sendEmailViaRelay = async (to: string, subject: string, html: string): Promise<boolean> => {
    try {
        const response = await fetch(process.env.EMAIL_RELAY_URL as string, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret: process.env.EMAIL_RELAY_SECRET,
                to,
                subject,
                html
            })
        });
        
        if (!response.ok) {
            throw new Error(`Google Relay hiba: ${response.statusText}`);
        }
        return true;
    } catch (error) {
        console.error('❌ EMAIL RELAY HIBA:', error);
        return false;
    }
};

router.post('/register', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            res.status(400).json({ error: 'Minden mező kitöltése kötelező!' });
            return;
        }

        const userExists = await query(
            'SELECT id FROM users WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (userExists.rows.length > 0) {
            res.status(409).json({ error: 'Ez az e-mail cím vagy felhasználónév már foglalt.' });
            return;
        }

        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(password, saltRounds);
        const verificationToken = crypto.randomBytes(32).toString('hex');

        const insertResult = await query(
            `INSERT INTO users (email, password_hash, username, is_verified, verification_token)
             VALUES ($1, $2, $3, false, $4) RETURNING id, username`,
            [email, passwordHash, username, verificationToken]
        );

        const newUser = insertResult.rows[0];
        
        // Dupla perjel (//) biztonságos kivédése
        const baseUrl = (process.env.APP_URL || '').replace(/\/+$/, '');
        const confirmUrl = `${baseUrl}/api/auth/verify?token=${verificationToken}`;
        
        const emailHtmlTemplate = `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #010a13; padding: 40px 20px;">
                <div style="max-width: 600px; margin: 0 auto; background-color: #091428; border: 1px solid #c8aa6e; padding: 40px; box-shadow: 0 0 20px rgba(200, 170, 110, 0.2);">
                    <h1 style="color: #c8aa6e; font-family: 'Oswald', sans-serif; text-transform: uppercase; letter-spacing: 2px; margin-top: 0;">Üdvözlünk a Worlds Mayhem rendszerében, ${newUser.username}!</h1>
                    <p style="color: #f0e6d2; font-size: 16px; line-height: 1.6;">A fiókod sikeresen létrejött. A belépéshez kérlek, erősítsd meg az e-mail címedet az alábbi gombra kattintva:</p>
                    <div style="text-align: left; margin: 40px 0;">
                        <a href="${confirmUrl}" style="background-color: #c8aa6e; color: #010a13; padding: 14px 28px; text-decoration: none; font-weight: bold; text-transform: uppercase; letter-spacing: 1px; display: inline-block;">E-mail cím megerősítése</a>
                    </div>
                    <p style="color: #888888; font-size: 12px; margin-top: 30px; border-top: 1px solid rgba(200, 170, 110, 0.2); padding-top: 20px;">Ha nem te regisztráltál a Worlds Mayhembe, kérjük, hagyd figyelmen kívül ezt a levelet.</p>
                </div>
            </div>
        `;

        sendEmailViaRelay(
            email, 
            'Worlds Mayhem - Fiók megerősítése', 
            emailHtmlTemplate
        ).then(success => {
            if (success) console.log(`✅ SIKERES EMAIL KÜLDÉS: ${email}`);
        });

        res.status(201).json({ message: 'Sikeres regisztráció! Kérlek, erősítsd meg az e-mail címedet a fiókodba érkezett levéllel.' });

    } catch (error: any) {
        res.status(500).json({ error: 'Belső szerverhiba történt a regisztráció során.' });
    }
});

router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        const { email, password } = req.body;

        const result = await query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user) {
            res.status(401).json({ error: 'Hibás e-mail cím vagy jelszó.' });
            return;
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            res.status(401).json({ error: 'Hibás e-mail cím vagy jelszó.' });
            return;
        }

        if (!user.is_verified) {
             res.status(403).json({ error: 'Kérjük, előbb erősítsd meg az e-mail címedet!' });
             return;
        }

        const token = jwt.sign(
            { userId: user.id, username: user.username },
            process.env.JWT_SECRET as string,
            { expiresIn: '24h' }
        );

        const cookieString = `auth_token=${token}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax; Secure`;
        res.setHeader('Set-Cookie', cookieString);
        
        console.log(JSON.stringify({ event: 'AUTH_LOGIN_SUCCESS', userId: user.id, cookieSent: true }));
        
        res.status(200).json({ message: 'Sikeres bejelentkezés!', user: { userId: user.id, username: user.username } });

    } catch (error: any) {
        res.status(500).json({ error: 'Belső szerverhiba történt a bejelentkezés során.' });
    }
});

router.get('/verify', async (req: Request, res: Response): Promise<void> => {
    try {
        const { token } = req.query;
        if (!token) {
            res.status(400).send(getHextechHtml('Hiba', 'Hiányzó azonosító!', 'Nem található érvényes megerősítő token a kérésben.', true));
            return;
        }

        const result = await query(
            'UPDATE users SET is_verified = true, verification_token = null WHERE verification_token = $1 RETURNING id', 
            [token]
        );
        
        if (result.rowCount === 0) {
            res.status(400).send(getHextechHtml('Hiba', 'Érvénytelen token!', 'A link már lejárt, vagy a fiókot korábban már megerősítették.', true));
            return;
        }

        res.send(getHextechHtml('Sikeres megerősítés', 'Sikeres megerősítés!', 'A fiókod hitelesítése sikeresen befejeződött.'));
    } catch (error: any) {
        res.status(500).send(getHextechHtml('Hiba', 'Szerverhiba!', 'Váratlan hiba történt a megerősítés során. Kérjük, próbáld újra később.', true));
    }
});

router.post('/logout', (req: Request, res: Response) => {
    res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    res.status(200).json({ message: 'Sikeres kijelentkezés.' });
});

export default router;