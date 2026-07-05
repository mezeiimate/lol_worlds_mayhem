import { pool } from './src/db';
import dotenv from 'dotenv';

dotenv.config();

async function seedTeams() {
    const client = await pool.connect();
    try {
        console.log('🔄 Történelmi e-sport csapatok betöltése...');
        await client.query('BEGIN');
        
        await client.query('TRUNCATE TABLE public.esport_players CASCADE');

        // Bővített történelmi adatbázis (8 csapat, 40 játékos)
        await client.query(`
            INSERT INTO public.esport_players (name, ingame_role, team_name, season, player_rating, country) VALUES
            -- T1 2024
            ('Zeus', 'TOP', 'T1', 2024, 92, 'KR'), ('Oner', 'JUNGLE', 'T1', 2024, 90, 'KR'), ('Faker', 'MID', 'T1', 2024, 98, 'KR'), ('Gumayusi', 'ADC', 'T1', 2024, 91, 'KR'), ('Keria', 'SUPPORT', 'T1', 2024, 94, 'KR'),
            -- RNG 2017
            ('Letme', 'TOP', 'RNG', 2017, 85, 'CN'), ('Mlxg', 'JUNGLE', 'RNG', 2017, 88, 'CN'), ('Xiaohu', 'MID', 'RNG', 2017, 89, 'CN'), ('Uzi', 'ADC', 'RNG', 2017, 97, 'CN'), ('Ming', 'SUPPORT', 'RNG', 2017, 90, 'CN'),
            -- FPX 2019
            ('GimGoon', 'TOP', 'FPX', 2019, 84, 'KR'), ('Tian', 'JUNGLE', 'FPX', 2019, 95, 'CN'), ('Doinb', 'MID', 'FPX', 2019, 96, 'KR'), ('Lwx', 'ADC', 'FPX', 2019, 87, 'CN'), ('Crisp', 'SUPPORT', 'FPX', 2019, 92, 'CN'),
            -- SSW 2014
            ('Looper', 'TOP', 'SSW', 2014, 88, 'KR'), ('Dandy', 'JUNGLE', 'SSW', 2014, 97, 'KR'), ('Pawn', 'MID', 'SSW', 2014, 92, 'KR'), ('Imp', 'ADC', 'SSW', 2014, 95, 'KR'), ('Mata', 'SUPPORT', 'SSW', 2014, 99, 'KR'),
            -- IG 2018
            ('TheShy', 'TOP', 'IG', 2018, 98, 'KR'), ('Ning', 'JUNGLE', 'IG', 2018, 91, 'CN'), ('Rookie', 'MID', 'IG', 2018, 97, 'KR'), ('JackeyLove', 'ADC', 'IG', 2018, 92, 'CN'), ('Baolan', 'SUPPORT', 'IG', 2018, 83, 'CN'),
            -- DWG 2020
            ('Nuguri', 'TOP', 'DWG', 2020, 96, 'KR'), ('Canyon', 'JUNGLE', 'DWG', 2020, 99, 'KR'), ('ShowMaker', 'MID', 'DWG', 2020, 97, 'KR'), ('Ghost', 'ADC', 'DWG', 2020, 85, 'KR'), ('Beryl', 'SUPPORT', 'DWG', 2020, 93, 'KR'),
            -- EDG 2021
            ('Flandre', 'TOP', 'EDG', 2021, 87, 'CN'), ('Jiejie', 'JUNGLE', 'EDG', 2021, 90, 'CN'), ('Scout', 'MID', 'EDG', 2021, 95, 'KR'), ('Viper', 'ADC', 'EDG', 2021, 96, 'KR'), ('Meiko', 'SUPPORT', 'EDG', 2021, 92, 'CN'),
            -- DRX 2022
            ('Kingen', 'TOP', 'DRX', 2022, 89, 'KR'), ('Pyosik', 'JUNGLE', 'DRX', 2022, 86, 'KR'), ('Zeka', 'MID', 'DRX', 2022, 95, 'KR'), ('Deft', 'ADC', 'DRX', 2022, 91, 'KR'), ('Beryl', 'SUPPORT', 'DRX', 2022, 90, 'KR')
        `);
        
        await client.query('COMMIT');
        console.log('✅ SIKER: 8 csapat (40 játékos) betöltve!');
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ HIBA a seedelés során:', error);
    } finally {
        client.release();
        process.exit(0);
    }
}

seedTeams();