import fs from 'fs';
const csv = require('csv-parser') as any;
import { pool } from './src/db';

// ---------------------------------------------------------
const CSV_FILE_PATH = '2025_LoL_esports_match_data_from_OraclesElixir.csv'; 
const TARGET_YEAR = 2025; 
// ---------------------------------------------------------

const WORLDS_LEAGUE_TAGS = ['WCS', 'WC', 'Worlds', 'WLDs', 'WLD']; 

const teamCountryMap: Record<string, string> = {
    // KOREA (KR)
    'SK Telecom T1': 'KR', 'T1': 'KR', 'Samsung White': 'KR', 'Samsung Blue': 'KR', 'Samsung Galaxy': 'KR',
    'KOO Tigers': 'KR', 'ROX Tigers': 'KR', 'KT Rolster': 'KR', 'Kingzone DragonX': 'KR', 'Longzhu Gaming': 'KR',
    'Griffin': 'KR', 'Dplus Kia': 'KR', 'DWG KIA': 'KR', 'DAMWON Gaming': 'KR', 'Gen.G': 'KR',
    'Hanwha Life Esports': 'KR', 'DRX': 'KR', 'NaJin White Shield': 'KR',
    
    // KÍNA (CN)
    'EDward Gaming': 'CN', 'Royal Never Give Up': 'CN', 'Star Horn Royal Club': 'CN', 'Invictus Gaming': 'CN',
    'FunPlus Phoenix': 'CN', 'LGD Gaming': 'CN', 'OMG': 'CN', 'JD Gaming': 'CN', 'Suning': 'CN',
    'Bilibili Gaming': 'CN', 'Weibo Gaming': 'CN', 'LNG Esports': 'CN', 'Top Esports': 'CN', 'I May': 'CN', 'Team WE': 'CN',
    
    // EURÓPA (EU)
    'Fnatic': 'EU', 'G2 Esports': 'EU', 'Origen': 'EU', 'H2K': 'EU', 'Alliance': 'EU', 'SK Gaming': 'EU',
    'Splyce': 'EU', 'Misfits Gaming': 'EU', 'Team Vitality': 'EU', 'MAD Lions': 'EU', 'MAD Lions KOI': 'EU',
    'Rogue': 'EU', 'KOI': 'EU', 'BDS': 'EU', 'Lemondogs': 'EU',
    
    // ÉSZAK-AMERIKA (NA)
    'Cloud9': 'NA', 'Team SoloMid': 'NA', 'TSM': 'NA', 'Counter Logic Gaming': 'NA', 'Team Liquid': 'NA',
    'Clutch Gaming': 'NA', '100 Thieves': 'NA', 'FlyQuest': 'NA', 'Evil Geniuses': 'NA', 'NRG': 'NA', 'Immortals': 'NA',
    
    // PCS / LMS / SEA
    'Flash Wolves': 'PCS', 'ahq eSports Club': 'PCS', 'J Team': 'PCS', 'Hong Kong Attitude': 'PCS',
    'Machi Esports': 'PCS', 'PSG Talon': 'PCS', 'Beyond Gaming': 'PCS', 'Taipei Assassins': 'PCS',
    'Bangkok Titans': 'SEA', 'MEGA': 'SEA', 'Ascension Gaming': 'SEA', 'MINESKI': 'SEA',
    
    // VIETNÁM (VN)
    'GAM Esports': 'VN', 'Phong Vũ Buffalo': 'VN', 'Lowkey Esports.Vietnam': 'VN', 'Team Whales': 'VN',
    
    // MINOR RÉGIÓK (BR, TR, CIS, LATAM, JP, OCE)
    'Kabum! e-Sports': 'BR', 'paiN Gaming': 'BR', 'INTZ': 'BR', 'Team oNe eSports': 'BR', 'KaBuM! e-Sports': 'BR',
    'Flamengo MDL': 'BR', 'RED Canids': 'BR', 'LOUD': 'BR',
    'Dark Passage': 'TR', 'SuperMassive': 'TR', '1907 Fenerbahçe': 'TR', 'Royal Youth': 'TR', 'Papara SuperMassive': 'TR',
    'Galatasaray Esports': 'TR', 'Istanbul Wildcats': 'TR',
    'Albus NoX Luna': 'CIS', 'Gambit Esports': 'CIS', 'Unicorns of Love.CIS': 'CIS', 'Vega Squadron': 'CIS',
    'Isurus': 'LATAM', 'Rainbow7': 'LATAM', 'Infinity Esports': 'LATAM', 'Estral Esports': 'LATAM',
    'DetonatioN FocusMe': 'JP', 'Rampage': 'JP', 'V3 Esports': 'JP',
    'MAMMOTH': 'OCE', 'Dire Wolves': 'OCE', 'Chiefs Esports Club': 'OCE', 'Pentanet.GG': 'OCE', 'PEACE': 'OCE'
};

const playersData: Record<string, any> = {};

async function processData() {
    console.log(`[ETL] CSV beolvasása és Főtáblás szűrés indul a(z) ${TARGET_YEAR}-es adatokon...`);

    if (!fs.existsSync(CSV_FILE_PATH)) {
        console.error(`❌ HIBA: A megadott CSV fájl (${CSV_FILE_PATH}) nem található!`);
        process.exit(1);
    }

    fs.createReadStream(CSV_FILE_PATH)
        .pipe(csv())
        .on('data', (row: any) => {
            const stageInfo = (row.stage || '').toLowerCase();
            const isPlayIn = stageInfo.includes('play-in') || stageInfo.includes('play in') || stageInfo.includes('pi');

            if (!isPlayIn && WORLDS_LEAGUE_TAGS.includes(row.league) && parseInt(row.year) === TARGET_YEAR && row.position !== 'team') {
                const pName = row.playername;

                if (!playersData[pName]) {
                    playersData[pName] = {
                        name: pName, team: row.teamname, role: row.position.toUpperCase(),
                        games: 0, kills: 0, deaths: 0, assists: 0, teamkills: 0,
                        dpm: 0, cspm: 0, vspm: 0, gd15: 0, dtpm: 0, dmg_share: 0,
                        gd10: 0, xpd10: 0, fb_kills: 0, enemy_jng_kills: 0, wards_killed: 0
                    };
                }

                playersData[pName].games += 1;
                playersData[pName].kills += parseInt(row.kills) || 0;
                playersData[pName].deaths += parseInt(row.deaths) || 0;
                playersData[pName].assists += parseInt(row.assists) || 0;
                playersData[pName].teamkills += parseInt(row.teamkills) || 1;
                
                playersData[pName].dpm += parseFloat(row.dpm) || 0;     
                playersData[pName].cspm += parseFloat(row.cspm) || 0;   
                playersData[pName].vspm += parseFloat(row.vspm) || 0;   
                playersData[pName].gd15 += parseFloat(row.golddiffat15) || 0;
                playersData[pName].dtpm += parseFloat(row.damagetakenperminute) || 0;
                playersData[pName].dmg_share += parseFloat(row.damageshare) || 0;

                // ÚJ: Fázis-specifikus mély statisztikák
                playersData[pName].gd10 += parseFloat(row.golddiffat10) || 0;
                playersData[pName].xpd10 += parseFloat(row.xpdiffat10) || 0;
                playersData[pName].fb_kills += parseInt(row.firstbloodkill) || 0;
                playersData[pName].enemy_jng_kills += parseFloat(row.monsterkillsenemyjungle) || 0;
                playersData[pName].wards_killed += parseFloat(row.wardskilled) || 0;
            }
        })
        .on('end', async () => {
            const parsedCount = Object.keys(playersData).length;
            if (parsedCount === 0) {
                console.error(`❌ HIBA: Egyetlen főtáblás meccset sem találtam a(z) ${TARGET_YEAR}-es fájlban!`);
                process.exit(1);
            }

            console.log(`[ETL] Aggregálás: ${parsedCount} játékos azonosítva.`);
            
            const playersList = Object.values(playersData).map(p => {
                return {
                    ...p,
                    avg_kda: (p.kills + p.assists) / Math.max(1, p.deaths),
                    avg_kp: ((p.kills + p.assists) / Math.max(1, p.teamkills)) * 100,
                    avg_dpm: p.dpm / p.games,
                    avg_cspm: p.cspm / p.games,
                    avg_vspm: p.vspm / p.games,
                    avg_gd15: p.gd15 / p.games,
                    avg_dtpm: p.dtpm / p.games,
                    avg_dmg_share: p.dmg_share / p.games,
                    // ÚJ átlagok
                    avg_gd10: p.gd10 / p.games,
                    avg_xpd10: p.xpd10 / p.games,
                    avg_fb_kills: p.fb_kills / p.games,
                    avg_enemy_jng_kills: p.enemy_jng_kills / p.games,
                    avg_wards_killed: p.wards_killed / p.games
                };
            });

            const roles = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];
            const minMax: any = {};
            roles.forEach(r => {
                const rolePlayers = playersList.filter(p => p.role === r);
                if(rolePlayers.length === 0) return;
                minMax[r] = {
                    max_kda: Math.max(...rolePlayers.map(p => p.avg_kda)),
                    max_kp: Math.max(...rolePlayers.map(p => p.avg_kp)),
                    max_dpm: Math.max(...rolePlayers.map(p => p.avg_dpm)),
                    max_cspm: Math.max(...rolePlayers.map(p => p.avg_cspm)),
                    max_vspm: Math.max(...rolePlayers.map(p => p.avg_vspm)),
                    max_dtpm: Math.max(...rolePlayers.map(p => p.avg_dtpm)),
                };
            });

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query('DELETE FROM public.esport_players WHERE season = $1::integer;', [TARGET_YEAR]);

                for (const p of playersList) {
                    let dbRole = p.role;
                    if (dbRole === 'BOT') dbRole = 'ADC';
                    if (dbRole === 'JNG') dbRole = 'JUNGLE';
                    if (dbRole === 'SUP') dbRole = 'SUPPORT';

                    const roleKey = p.role;
                    const stats = minMax[roleKey] || minMax['MID'];

                    const score_kda = stats.max_kda > 0 ? (p.avg_kda / stats.max_kda) * 100 : 0;
                    const score_kp = (stats.max_kp > 0) ? (p.avg_kp / stats.max_kp) * 100 : 0;
                    const score_dpm = (stats.max_dpm > 0) ? (p.avg_dpm / stats.max_dpm) * 100 : 0;
                    const score_cspm = (stats.max_cspm > 0) ? (p.avg_cspm / stats.max_cspm) * 100 : 0;
                    const score_vspm = (stats.max_vspm > 0) ? (p.avg_vspm / stats.max_vspm) * 100 : 0;
                    const score_dtpm = (stats.max_dtpm > 0) ? (p.avg_dtpm / stats.max_dtpm) * 100 : 0;

                    let final_rating = 50;
                    if (dbRole === 'SUPPORT') {
                        final_rating = (score_vspm * 0.45) + (score_kp * 0.35) + (score_kda * 0.20);
                    } else if (dbRole === 'ADC' || dbRole === 'MID') {
                        final_rating = (score_dpm * 0.35) + (score_cspm * 0.30) + (score_kda * 0.20) + (score_kp * 0.15);
                    } else if (dbRole === 'JUNGLE') {
                        final_rating = (score_kp * 0.40) + (score_vspm * 0.30) + (score_kda * 0.20) + (score_dtpm * 0.10);
                    } else { 
                        final_rating = (score_dpm * 0.20) + (score_dtpm * 0.20) + (score_cspm * 0.20) + (score_kp * 0.20) + (score_kda * 0.20);
                    }

                    // Tiszta Worlds teljesítmény - nincs régiós szorzó, csak meccsszám büntetés
                    let gamePenalty = p.games < 5 ? 0.85 : 1.0; 
                    final_rating = final_rating * gamePenalty;

                    let normalized_rating = Math.floor(70 + (final_rating / 100) * 29);
                    if (isNaN(normalized_rating) || normalized_rating < 70) normalized_rating = 70 + Math.floor(Math.random() * 5);
                    if (normalized_rating > 99) normalized_rating = 99;

                    const mappedCountry = teamCountryMap[p.team] || 'Unknown';

                    await client.query(`
                        INSERT INTO public.esport_players 
                        (name, ingame_role, team_name, season, player_rating, country, cspm, dpm, vspm, kda, kp_percentage, gd15, dtpm, damage_share, gd10, xpd10, fb_kills, enemy_jng_kills, wards_killed)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
                    `, [
                        p.name, dbRole, p.team, TARGET_YEAR, normalized_rating, mappedCountry,
                        p.avg_cspm.toFixed(2), p.avg_dpm.toFixed(2), p.avg_vspm.toFixed(2), p.avg_kda.toFixed(2), p.avg_kp.toFixed(2),
                        p.avg_gd15.toFixed(2), p.avg_dtpm.toFixed(2), p.avg_dmg_share.toFixed(4),
                        // Új statok mentése
                        p.avg_gd10.toFixed(2), p.avg_xpd10.toFixed(2), p.avg_fb_kills.toFixed(4), p.avg_enemy_jng_kills.toFixed(2), p.avg_wards_killed.toFixed(2)
                    ]);
                }

                await client.query('COMMIT');
                console.log(`\n✅ SIKERES IMPORTÁLÁS: ${TARGET_YEAR} FŐTÁBLA adatai mentve az új fázis-statisztikákkal!`);
            } catch (error) {
                await client.query('ROLLBACK');
                console.error('❌ Hiba történt a feltöltés közben:', error);
            } finally {
                client.release();
                process.exit(0);
            }
        });
}

processData();