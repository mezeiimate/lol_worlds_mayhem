import { pool } from './src/db';
import dotenv from 'dotenv';

dotenv.config();

async function runMigration() {
    const client = await pool.connect();
    try {
        console.log('🔄 Adatbázis séma frissítése a szimulációs fázishoz...');
        await client.query('BEGIN');

        // 1. Lobbies tábla bővítése
        console.log('-> Lobbies tábla frissítése...');
        await client.query(`
            ALTER TABLE public.lobbies 
            ADD COLUMN IF NOT EXISTS status VARCHAR(50) DEFAULT 'DRAFTING',
            ADD COLUMN IF NOT EXISTS current_match_index INTEGER DEFAULT 0;
        `);

        // 2. Lobby_teams (résztvevők) tábla bővítése a csoportkörökhöz és botokhoz
        console.log('-> Lobby_teams tábla frissítése...');
        await client.query(`
            ALTER TABLE public.lobby_teams 
            ADD COLUMN IF NOT EXISTS is_ready BOOLEAN DEFAULT FALSE,
            ADD COLUMN IF NOT EXISTS bot_name VARCHAR(50),
            ADD COLUMN IF NOT EXISTS group_name VARCHAR(1), -- 'A', 'B', 'C', 'D'
            ADD COLUMN IF NOT EXISTS group_wins INTEGER DEFAULT 0,
            ADD COLUMN IF NOT EXISTS group_losses INTEGER DEFAULT 0;
        `);

        // 3. Vadonatúj Matches tábla létrehozása
        console.log('-> Matches tábla létrehozása...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS public.matches (
                id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
                lobby_id UUID REFERENCES public.lobbies(id) ON DELETE CASCADE,
                team1_id UUID REFERENCES public.lobby_teams(id) ON DELETE CASCADE,
                team2_id UUID REFERENCES public.lobby_teams(id) ON DELETE CASCADE,
                winner_id UUID REFERENCES public.lobby_teams(id) ON DELETE CASCADE,
                match_type VARCHAR(50) NOT NULL, -- 'GROUP', 'QUARTER', 'SEMI', 'FINAL'
                status VARCHAR(50) DEFAULT 'PENDING',
                match_logs JSONB DEFAULT '[]'::jsonb,
                match_order INTEGER NOT NULL
            );
        `);

        await client.query('COMMIT');
        console.log('✅ SIKER: Az adatbázis felkészítve a 16 csapatos Worlds szimulációra!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ HIBA a migráció során:', error);
    } finally {
        client.release();
        process.exit(0);
    }
}

runMigration();