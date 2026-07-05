import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Kiterjesztjük az Express Request objektumot a saját adatainkkal
export interface AuthRequest extends Request {
    user?: { userId: string; username: string };
}

export const requireAuth = (req: AuthRequest, res: Response, next: NextFunction): void => {
    const token = req.cookies.auth_token;

    // Ha nincs süti, azonnal eldobjuk a kérést a loginra
    if (!token) {
        res.redirect('/login');
        return;
    }

    try {
        // Token dekódolása és validálása (lejárat, aláírás ellenőrzése)
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret') as { userId: string; username: string };
        
        // Ha sikeres, ráakasztjuk az adatokat a requestre, és továbbengedjük a folyamatot
        req.user = decoded;
        next();
    } catch (error) {
        // Ha a token lejárt vagy manipulálták, töröljük és kiléptetjük
        res.clearCookie('auth_token');
        res.redirect('/login');
        return;
    }
};