import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { query } from '../db';

const router = Router();

// Segédfüggvény az e-mail küldéshez a Google Apps Script relay-en keresztül
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
        const confirmUrl = `${process.env.APP_URL}/api/auth/verify?token=${verificationToken}`;
        
        // Formázott HTML e-mail sablon
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

        // E-mail küldés a relay-en keresztül
        sendEmailViaRelay(
            email, 
            'Worlds Mayhem - Fiók megerősítése', 
            emailHtmlTemplate
        ).then(success => {
            if (success) console.log(`✅ SIKERES EMAIL KÜLDÉS: ${email}`);
        });

        res.status(201).json({ message: 'Sikeres regisztráció! Kérjük, erősítsd meg az e-mail címedet.' });

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
            res.status(400).send('Hiányzó token.');
            return;
        }

        const result = await query(
            'UPDATE users SET is_verified = true, verification_token = null WHERE verification_token = $1 RETURNING id', 
            [token]
        );
        
        if (result.rowCount === 0) {
            res.status(400).send('Érvénytelen vagy már felhasznált token.');
            return;
        }

        res.send('<h1>Sikeres megerősítés!</h1><p>Most már bejelentkezhetsz a játékba.</p>');
    } catch (error: any) {
        res.status(500).send('Hiba történt a megerősítés során.');
    }
});

router.post('/logout', (req: Request, res: Response) => {
    res.setHeader('Set-Cookie', 'auth_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure');
    res.status(200).json({ message: 'Sikeres kijelentkezés.' });
});

export default router;