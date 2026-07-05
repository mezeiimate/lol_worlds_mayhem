import axios from 'axios';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { pool } from './src/db';

dotenv.config();

const API_URL = 'https://lol.fandom.com/api.php';
const IMAGES_DIR = path.join(process.cwd(), 'public', 'images');
const TEAMS_DIR = path.join(IMAGES_DIR, 'teams');
const PLAYERS_DIR = path.join(IMAGES_DIR, 'players');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
    },
    timeout: 10000
};

async function ensureDirectories() {
    if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
    if (!fs.existsSync(TEAMS_DIR)) fs.mkdirSync(TEAMS_DIR, { recursive: true });
    if (!fs.existsSync(PLAYERS_DIR)) fs.mkdirSync(PLAYERS_DIR, { recursive: true });
}

async function getImageUrl(fileName: string): Promise<string | null> {
    try {
        const response = await axios.get(API_URL, {
            ...axiosConfig,
            params: { action: 'query', format: 'json', prop: 'imageinfo', titles: fileName, iiprop: 'url' }
        });
        const pages = response.data?.query?.pages;
        if (pages) {
            const pageId = Object.keys(pages)[0];
            if (pageId !== '-1' && pages[pageId].imageinfo) {
                return pages[pageId].imageinfo[0].url;
            }
        }
    } catch (error) {}
    return null;
}

async function getPlayerImageCandidate(playerName: string): Promise<string | null> {
    const safeSqlName = playerName.replace(/'/g, "''");
    
    // 1. Cargo API - Players tábla
    try {
        const cargoRes = await axios.get(API_URL, {
            ...axiosConfig,
            params: { action: 'cargoquery', format: 'json', tables: 'Players', fields: 'Image', where: `ID='${safeSqlName}' OR Player='${safeSqlName}'`, limit: 1 }
        });
        if (cargoRes.data?.cargoquery?.length > 0) {
            const img = cargoRes.data.cargoquery[0].title.Image;
            if (img && img.trim() !== '') return `File:${img}`;
        }
    } catch(e) {}

    // 2. Fallback: Sima MediaWiki query (Közvetlen csatolmányok)
    try {
        const pageRes = await axios.get(API_URL, {
            ...axiosConfig,
            params: { action: 'query', format: 'json', titles: playerName, prop: 'images', imlimit: 50 }
        });
        const pages = pageRes.data?.query?.pages;
        if (pages) {
            const pageId = Object.keys(pages)[0];
            if (pageId !== '-1' && pages[pageId].images) {
                const images = pages[pageId].images.map((img: any) => img.title);
                const candidate = images.find((i: string) => 
                    i.includes(playerName) && 
                    !i.includes('Square') && 
                    !i.includes('Logo') && 
                    !i.includes('Icon') && 
                    (i.endsWith('.png') || i.endsWith('.jpg'))
                );
                if (candidate) return candidate;
            }
        }
    } catch(e) {}

    return null;
}

async function getTeamImageCandidate(teamName: string): Promise<string | null> {
    const safeSqlName = teamName.replace(/'/g, "''");
    
    try {
        const cargoRes = await axios.get(API_URL, {
            ...axiosConfig,
            params: { action: 'cargoquery', format: 'json', tables: 'Teams', fields: 'Image, Logo', where: `Name='${safeSqlName}' OR Short='${safeSqlName}'`, limit: 1 }
        });
        if (cargoRes.data?.cargoquery?.length > 0) {
            const title = cargoRes.data.cargoquery[0].title;
            const img = title.Image || title.Logo;
            if (img && img.trim() !== '') return `File:${img}`;
        }
    } catch(e) {}

    return `File:${teamName}logo square.png`;
}

async function downloadImage(url: string, filepath: string, genericFilepath: string) {
    if (fs.existsSync(filepath)) return; 

    try {
        const response = await axios({ url, method: 'GET', responseType: 'stream', ...axiosConfig });
        const writer = fs.createWriteStream(filepath);
        response.data.pipe(writer);
        
        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Generikus másolat létrehozása a Dashboard meccstörténethez
        fs.copyFileSync(filepath, genericFilepath);
    } catch (error) {
        console.log(`[Letöltési Hiba] Fájl nem elérhető: ${url}`);
    }
}

async function syncAssets() {
    console.log('✅ Kép-szinkronizációs folyamat elindítva...');
    await ensureDirectories();

    const client = await pool.connect();
    
    try {
        console.log('\nJátékosok profilképeinek feldolgozása...');
        const playersRes = await client.query('SELECT DISTINCT name, season FROM public.esport_players');
        
        for (const player of playersRes.rows) {
            const safeName = player.name.replace(/[^a-zA-Z0-9]/g, ''); 
            const filepath = path.join(PLAYERS_DIR, `${safeName}_${player.season}.png`);
            const genericFilepath = path.join(PLAYERS_DIR, `${safeName}.png`);
            
            if (!fs.existsSync(filepath)) {
                process.stdout.write(`Keresés: ${player.name} (${player.season})... `);
                const fileName = await getPlayerImageCandidate(player.name);
                
                if (fileName) {
                    const imageUrl = await getImageUrl(fileName);
                    if (imageUrl) {
                        await downloadImage(imageUrl, filepath, genericFilepath);
                        console.log(`[+] Letöltve!`);
                    } else {
                        console.log(`[-] Nincs direkt URL.`);
                    }
                } else {
                    console.log(`[-] Fandomon nincs találat.`);
                }
                await delay(400); // 400ms szünet a Fandom túlterhelésének elkerülésére
            }
        }

        console.log('\nCsapatlogók feldolgozása...');
        const teamsRes = await client.query('SELECT DISTINCT team_name, season FROM public.esport_players');
        
        for (const team of teamsRes.rows) {
            const safeTeamName = team.team_name.replace(/[^a-zA-Z0-9]/g, '');
            const filepath = path.join(TEAMS_DIR, `${safeTeamName}_${team.season}.png`);
            const genericFilepath = path.join(TEAMS_DIR, `${safeTeamName}.png`);
            
            if (!fs.existsSync(filepath)) {
                process.stdout.write(`Keresés: ${team.team_name} (${team.season})... `);
                const fileName = await getTeamImageCandidate(team.team_name);
                
                if (fileName) {
                    const imageUrl = await getImageUrl(fileName);
                    if (imageUrl) {
                        await downloadImage(imageUrl, filepath, genericFilepath);
                        console.log(`[+] Letöltve!`);
                    } else {
                        console.log(`[-] Nincs direkt URL.`);
                    }
                } else {
                    console.log(`[-] Fandomon nincs találat.`);
                }
                await delay(400);
            }
        }

        console.log('\n✅ Szinkronizáció sikeresen befejeződött!');

    } catch (error) {
        console.error('Kritikus hiba az ETL folyamat során:', error);
    } finally {
        client.release();
        process.exit(0);
    }
}

syncAssets();