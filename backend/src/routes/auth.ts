import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import crypto from 'crypto';
import { query } from '../db';

const router = Router();

// E-mail küldő (Brevo) konfigurálása profi Timeout beállításokkal
const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    secure: process.env.SMTP_PORT === '465', // 465-ös portnál kötelező a true
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
    },
    // Szigorú időkorlátok a végtelen lógás ellen (10 másodperc)
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 10000,
});

// Regisztráció
router.post('/register', async (req: Request, res: Response): Promise<void> => {
    try {
        const { username, email, password } = req.body;

        console.log(JSON.stringify({ event: 'AUTH_REGISTER_ATTEMPT', timestamp: new Date().toISOString() }));

        if (!username || !email || !password) {
            res.status(400).json({ error: 'Minden mező kitöltése kötelező!' });
            return;
        }

        const userExists = await query(
            'SELECT id FROM users WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (userExists.rows.length > 0) {
            console.warn(JSON.stringify({ event: 'AUTH_REGISTER_CONFLICT', reason: 'Email or username already exists' }));
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
        console.log(JSON.stringify({ event: 'AUTH_REGISTER_SUCCESS', userId: newUser.id }));

        const confirmUrl = `${process.env.APP_URL}/api/auth/verify?token=${verificationToken}`;
        
        // Aszinkron e-mail küldés (Fire and Forget) - Nem blokkolja a válaszadást!
        transporter.sendMail({
            from: process.env.SMTP_FROM,
            to: email,
            subject: 'Worlds Mayhem - Fiók megerősítése',
            html: `<h1>Üdv a Worlds Mayhemben, ${newUser.username}!</h1><p>Kattints az alábbi linkre a fiókod megerősítéséhez:</p><a href="${confirmUrl}">Fiók megerősítése</a>`
        }).then(() => {
            console.log(JSON.stringify({ event: 'EMAIL_SEND_SUCCESS', type: 'VERIFICATION' }));
        }).catch((emailError: any) => {
            console.error(JSON.stringify({ event: 'EMAIL_SEND_ERROR', error: emailError.message }));
        });

        // Azonnal visszatérünk a klienshez 201-es kóddal
        res.status(201).json({ message: 'Sikeres regisztráció! Kérjük, erősítsd meg az e-mail címedet (ellenőrizd a Spam mappát is).' });

    } catch (error: any) {
        console.error(JSON.stringify({ event: 'AUTH_REGISTER_CRITICAL_ERROR', error: error.message, stack: error.stack }));
        res.status(500).json({ error: 'Belső szerverhiba történt a regisztráció során.' });
    }
});

// Bejelentkezés
router.post('/login', async (req: Request, res: Response): Promise<void> => {
    try {
        console.log(JSON.stringify({ event: 'AUTH_LOGIN_ATTEMPT', timestamp: new Date().toISOString() }));
        const { email, password } = req.body;

        const result = await query('SELECT * FROM users WHERE email = $1', [email]);
        const user = result.rows[0];

        if (!user) {
            console.warn(JSON.stringify({ event: 'AUTH_LOGIN_FAILED', reason: 'User not found' }));
            res.status(401).json({ error: 'Hibás e-mail cím vagy jelszó.' });
            return;
        }

        const isValidPassword = await bcrypt.compare(password, user.password_hash);
        if (!isValidPassword) {
            console.warn(JSON.stringify({ event: 'AUTH_LOGIN_FAILED', reason: 'Invalid password', userId: user.id }));
            res.status(401).json({ error: 'Hibás e-mail cím vagy jelszó.' });
            return;
        }

        if (!user.is_verified) {
            console.warn(JSON.stringify({ event: 'AUTH_LOGIN_DENIED', reason: 'Unverified email', userId: user.id }));
             res.status(403).json({ error: 'Kérjük, előbb erősítsd meg az e-mail címedet!' });
             return;
        }

        const token = jwt.sign(
            { id: user.id, username: user.username },
            process.env.JWT_SECRET as string,
            { expiresIn: '24h' }
        );

        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 24 * 60 * 60 * 1000 // 1 nap
        });

        console.log(JSON.stringify({ event: 'AUTH_LOGIN_SUCCESS', userId: user.id }));
        res.status(200).json({ message: 'Sikeres bejelentkezés!', user: { id: user.id, username: user.username } });

    } catch (error: any) {
        console.error(JSON.stringify({ event: 'AUTH_LOGIN_CRITICAL_ERROR', error: error.message }));
        res.status(500).json({ error: 'Belső szerverhiba történt a bejelentkezés során.' });
    }
});

// E-mail megerősítése
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

        console.log(JSON.stringify({ event: 'AUTH_VERIFY_SUCCESS', userId: result.rows[0].id }));
        res.send('<h1>Sikeres megerősítés!</h1><p>Most már bejelentkezhetsz a játékba.</p>');
    } catch (error: any) {
        console.error(JSON.stringify({ event: 'AUTH_VERIFY_CRITICAL_ERROR', error: error.message }));
        res.status(500).send('Hiba történt a megerősítés során.');
    }
});

// Kijelentkezés
router.post('/logout', (req: Request, res: Response) => {
    res.clearCookie('auth_token');
    console.log(JSON.stringify({ event: 'AUTH_LOGOUT_SUCCESS' }));
    res.status(200).json({ message: 'Sikeres kijelentkezés.' });
});

export default router;