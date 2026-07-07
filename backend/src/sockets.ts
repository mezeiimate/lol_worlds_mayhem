import { Server, Socket } from 'socket.io';
import { pool } from './db';
import { z } from 'zod';

const IdentifySchema = z.object({ userId: z.string().uuid() });
const SendInviteSchema = z.object({ userId: z.string().uuid(), targetUserId: z.string().uuid(), lobbyId: z.string().uuid() });

const CreateLobbySchema = z.object({ userId: z.string().uuid() });
const JoinLobbySchema = z.object({ userId: z.string().uuid(), inviteCode: z.string().length(6).toUpperCase() });
const RollSchema = z.object({ lobbyId: z.string().uuid(), userId: z.string().uuid() });
const ReadySchema = z.object({ lobbyId: z.string().uuid(), userId: z.string().uuid() });
const NextMatchSchema = z.object({ lobbyId: z.string().uuid(), userId: z.string().uuid() });
const FastForwardSchema = z.object({ lobbyId: z.string().uuid(), userId: z.string().uuid(), mode: z.enum(['group', 'all', 'bo5']) });
const PickSchema = z.object({ 
    lobbyId: z.string().uuid(), userId: z.string().uuid(), 
    playerId: z.string().uuid(), role: z.enum(['TOP', 'JUNGLE', 'MID', 'ADC', 'SUPPORT']) 
});

const generateInviteCode = () => Array.from({ length: 6 }, () => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.charAt(Math.floor(Math.random() * 36))).join('');
const RoleColumnMap: Record<string, string> = { 'TOP': 'top_player_id', 'JUNGLE': 'jng_player_id', 'MID': 'mid_player_id', 'ADC': 'adc_player_id', 'SUPPORT': 'sup_player_id' };

function calculateSynergyBonus(players: any[]) {
    let bonus = 0;
    const teamCounts: Record<string, number> = {};
    const countryCounts: Record<string, number> = {};
    
    players.forEach(p => {
        const exactTeamKey = `${p.team_name}_${p.season}`; // Az igazi "Tökéletes Roster" szinergia
        teamCounts[exactTeamKey] = (teamCounts[exactTeamKey] || 0) + 1;
        countryCounts[p.country] = (countryCounts[p.country] || 0) + 1;
    });
    
    Object.values(teamCounts).forEach(count => {
        if (count === 2) bonus += 5; else if (count === 3) bonus += 12; else if (count === 4) bonus += 20; else if (count === 5) bonus += 30;
    });
    Object.values(countryCounts).forEach(count => {
        if (count === 3) bonus += 4; else if (count === 4) bonus += 8; else if (count === 5) bonus += 12;
    });
    
    return bonus;
}

// Elo-alapú győzelmi esély számító (0.0 - 1.0)
function getWinProbability(power1: number, power2: number, scaleFactor: number = 50): number {
    return 1 / (1 + Math.pow(10, (power2 - power1) / scaleFactor));
}

async function getLobbyStateData(client: any, lobbyId: string) {
    const res = await client.query(`
        SELECT 
            lt.user_id, lt.id as team_id, u.username, lt.is_ready, lt.bot_name, lt.group_name, lt.group_wins, lt.group_losses,
            p_top.name AS top_name, p_top.season AS top_season, p_top.country AS top_country, p_top.team_name AS top_team,
            p_jng.name AS jng_name, p_jng.season AS jng_season, p_jng.country AS jng_country, p_jng.team_name AS jng_team,
            p_mid.name AS mid_name, p_mid.season AS mid_season, p_mid.country AS mid_country, p_mid.team_name AS mid_team,
            p_adc.name AS adc_name, p_adc.season AS adc_season, p_adc.country AS adc_country, p_adc.team_name AS adc_team,
            p_sup.name AS sup_name, p_sup.season AS sup_season, p_sup.country AS sup_country, p_sup.team_name AS sup_team
        FROM public.lobby_teams lt
        LEFT JOIN public.users u ON lt.user_id = u.id
        LEFT JOIN public.esport_players p_top ON lt.top_player_id = p_top.id 
        LEFT JOIN public.esport_players p_jng ON lt.jng_player_id = p_jng.id
        LEFT JOIN public.esport_players p_mid ON lt.mid_player_id = p_mid.id 
        LEFT JOIN public.esport_players p_adc ON lt.adc_player_id = p_adc.id
        LEFT JOIN public.esport_players p_sup ON lt.sup_player_id = p_sup.id
        WHERE lt.lobby_id = $1::uuid
        ORDER BY lt.group_name ASC, lt.group_wins DESC, lt.group_losses ASC, lt.id ASC
    `, [lobbyId]);

    const lobbyRes = await client.query('SELECT host_id, status FROM public.lobbies WHERE id = $1::uuid', [lobbyId]);
    const bracketRes = await client.query(`
        SELECT m.id, m.match_type, m.status, m.match_order,
               COALESCE(u1.username, t1.bot_name) as team1_name, COALESCE(u2.username, t2.bot_name) as team2_name, COALESCE(uw.username, tw.bot_name) as winner_name
        FROM public.matches m
        JOIN public.lobby_teams t1 ON m.team1_id = t1.id LEFT JOIN public.users u1 ON t1.user_id = u1.id
        JOIN public.lobby_teams t2 ON m.team2_id = t2.id LEFT JOIN public.users u2 ON t2.user_id = u2.id
        LEFT JOIN public.lobby_teams tw ON m.winner_id = tw.id LEFT JOIN public.users uw ON tw.user_id = uw.id
        WHERE m.lobby_id = $1::uuid AND m.match_type IN ('QUARTER', 'SEMI', 'FINAL') ORDER BY m.match_order ASC
    `, [lobbyId]);

    const currentMatchRes = await client.query(`SELECT match_order, match_type FROM public.matches WHERE lobby_id = $1::uuid AND status = 'PENDING' ORDER BY match_order ASC LIMIT 1`, [lobbyId]);
    const currentOrder = (currentMatchRes.rowCount ?? 0) > 0 ? parseInt(currentMatchRes.rows[0].match_order) : null;
    const currentPhase = (currentMatchRes.rowCount ?? 0) > 0 ? currentMatchRes.rows[0].match_type : null;

    return { players: res.rows, hostId: lobbyRes.rows[0].host_id, status: lobbyRes.rows[0].status, bracket: bracketRes.rows, currentMatchOrder: currentOrder, currentPhase: currentPhase };
}

async function broadcastLobbyState(io: Server, lobbyId: string) {
    const client = await pool.connect();
    try { const data = await getLobbyStateData(client, lobbyId); io.to(lobbyId).emit('lobby_state_update', data); } 
    catch (error) { console.error('[Socket] Broadcast error:', error); } finally { client.release(); }
}

async function executeMatchSimulation(client: any, currentMatch: any, io: Server, lobbyId: string, emitEvent: boolean) {
    const name1 = currentMatch.t1_user || currentMatch.t1_bot;
    const name2 = currentMatch.t2_user || currentMatch.t2_bot;
    const isBO5 = currentMatch.match_type !== 'GROUP';
    
    let groupMatchIndex = 0;
    if (!isBO5) { groupMatchIndex = ((currentMatch.match_order - 1) % 6) + 1; }
    const matchTypeTranslated = !isBO5 ? `'${currentMatch.group_name}' csoportkör (${groupMatchIndex}/6. meccs)` : 
                               currentMatch.match_type === 'QUARTER' ? 'Negyeddöntő (BO5)' :
                               currentMatch.match_type === 'SEMI' ? 'Elődöntő (BO5)' : 'Nagydöntő (BO5)';

    const getDetailedTeamStats = async (teamId: string) => {
        const r = await client.query(`
            SELECT p.name, p.season, p.player_rating, p.cspm, p.dpm, p.vspm, p.kda, p.kp_percentage, 
                   p.gd15, p.dtpm, p.damage_share, p.team_name, p.country, p.ingame_role,
                   p.gd10, p.xpd10, p.fb_kills, p.enemy_jng_kills, p.wards_killed
            FROM public.lobby_teams lt
            JOIN public.esport_players p ON p.id IN (lt.top_player_id, lt.jng_player_id, lt.mid_player_id, lt.adc_player_id, lt.sup_player_id)
            WHERE lt.id = $1::uuid
        `, [teamId]);
        
        let totalOvr = 0; let earlyStats = 0; let midStats = 0; let lateStats = 0;
        
        r.rows.forEach((p: any) => {
            totalOvr += parseInt(p.player_rating) || 70;
            // Early (Ösvényfázis, FB, Aranyelőny)
            earlyStats += (parseFloat(p.gd10) * 0.02) + (parseFloat(p.xpd10) * 0.02) + (parseFloat(p.fb_kills) * 25) + (parseFloat(p.enemy_jng_kills) * 5);
            // Mid (Objektíva kontroll, Vision, Rotálás)
            midStats += (parseFloat(p.vspm) * 12) + (parseFloat(p.wards_killed) * 15) + (parseFloat(p.kp_percentage) * 0.6);
            // Late (Csapatharc sebzés, Frontvonal)
            lateStats += (parseFloat(p.dpm) * 0.05) + (parseFloat(p.dtpm) * 0.02) + (parseFloat(p.damage_share) * 60);
        });
        
        const synergy = calculateSynergyBonus(r.rows);
        const basePower = totalOvr + (synergy * 1.5);

        return { 
            earlyPower: basePower + earlyStats, 
            midPower: basePower + midStats, 
            latePower: basePower + lateStats, 
            players: r.rows 
        };
    };

    const team1Stats = await getDetailedTeamStats(currentMatch.team1_id);
    const team2Stats = await getDetailedTeamStats(currentMatch.team2_id);

    // --- 1. FÁZIS: EARLY GAME ---
    const earlyProb = getWinProbability(team1Stats.earlyPower, team2Stats.earlyPower, 40);
    const p1WinnerId = Math.random() < earlyProb ? currentMatch.team1_id : currentMatch.team2_id;
    const p1WinnerName = p1WinnerId === currentMatch.team1_id ? name1 : name2;
    
    // Snowball effektus beállítása
    const t1MomentumMid = p1WinnerId === currentMatch.team1_id ? 25 : 0;
    const t2MomentumMid = p1WinnerId === currentMatch.team2_id ? 25 : 0;

    // --- 2. FÁZIS: MID GAME ---
    const midProb = getWinProbability(team1Stats.midPower + t1MomentumMid, team2Stats.midPower + t2MomentumMid, 45);
    const p2WinnerId = Math.random() < midProb ? currentMatch.team1_id : currentMatch.team2_id;
    const p2WinnerName = p2WinnerId === currentMatch.team1_id ? name1 : name2;

    const t1MomentumLate = (p2WinnerId === currentMatch.team1_id ? 30 : 0) + t1MomentumMid;
    const t2MomentumLate = (p2WinnerId === currentMatch.team2_id ? 30 : 0) + t2MomentumMid;

    // --- 3. FÁZIS: LATE GAME (VÉGEREDMÉNY) ---
    const lateProb = getWinProbability(team1Stats.latePower + t1MomentumLate, team2Stats.latePower + t2MomentumLate, 50);
    const gameWinnerId = Math.random() < lateProb ? currentMatch.team1_id : currentMatch.team2_id;
    const gameWinnerName = gameWinnerId === currentMatch.team1_id ? name1 : name2;

    // Dinamikus log generálás
    const logsArray = [];
    logsArray.push({ text: `Kezdődik a mérkőzés! ${name1} és ${name2} csapnak össze az Idézők Szurdokában.`, favoredTeamId: null });
    
    if (p1WinnerId === currentMatch.team1_id) {
        logsArray.push({ text: `[10. perc] ${p1WinnerName} letarolta az ösvényeket! Hatalmas farm és XP előnyt építettek ki a korai gyilkosságoknak köszönhetően.`, favoredTeamId: p1WinnerId });
    } else {
        logsArray.push({ text: `[10. perc] Briliáns korai játék a(z) ${p1WinnerName} részéről! A dzsungelesük folyamatosan büntette az ellenfél hibáit.`, favoredTeamId: p1WinnerId });
    }

    if (p2WinnerId === p1WinnerId) {
        logsArray.push({ text: `[20. perc] Lenyűgöző hógolyó-effektus! A(z) ${p2WinnerName} a korai előnyből tökéletes látótér-kontrollt épített, és elhozta a sárkányokat.`, favoredTeamId: p2WinnerId });
    } else {
        logsArray.push({ text: `[20. perc] Remek válasz! A(z) ${p2WinnerName} okos rotálásokkal és stabil Wardinggal visszahozta a meccset a középső szakaszban.`, favoredTeamId: p2WinnerId });
    }

    if (gameWinnerId === p2WinnerId) {
        logsArray.push({ text: `[Végjáték] Nem volt esély a fordításra. A(z) ${gameWinnerName} nyers sebzése (DPM) felőrölte az ellenfél frontvonalát a végső csapatharcban!`, favoredTeamId: gameWinnerId });
    } else {
        logsArray.push({ text: `[Végjáték] ELKÉPESZTŐ FORDÍTÁS! A(z) ${gameWinnerName} hátrányból skálázódott be, és egy tökéletes late-game csapatharccal ellopta a győzelmet!`, favoredTeamId: gameWinnerId });
    }

    const dbLogs = typeof currentMatch.match_logs === 'string' ? JSON.parse(currentMatch.match_logs) : (currentMatch.match_logs || []);
    let wins1 = 0; let wins2 = 0;
    for (const log of dbLogs) { if (log.winnerId === currentMatch.team1_id) wins1++; else wins2++; }
    if (gameWinnerId === currentMatch.team1_id) wins1++; else wins2++;
    
    dbLogs.push({ winnerId: gameWinnerId, text: `${gameWinnerName} behúzta a győzelmet a sorozatban.` });
    const gameNumber = wins1 + wins2;
    let isSeriesFinished = false; let seriesWinnerId = null;

    if (isBO5) {
        if (wins1 === 3 || wins2 === 3) {
            isSeriesFinished = true; seriesWinnerId = wins1 === 3 ? currentMatch.team1_id : currentMatch.team2_id;
            await client.query(`UPDATE public.matches SET status = 'FINISHED', winner_id = $1::uuid, match_logs = $2::jsonb WHERE id = $3::uuid`, [seriesWinnerId, JSON.stringify(dbLogs), currentMatch.id]);
        } else { await client.query(`UPDATE public.matches SET match_logs = $1::jsonb WHERE id = $2::uuid`, [JSON.stringify(dbLogs), currentMatch.id]); }
    } else {
        isSeriesFinished = true; seriesWinnerId = gameWinnerId;
        await client.query(`UPDATE public.matches SET status = 'FINISHED', winner_id = $1::uuid, match_logs = $2::jsonb WHERE id = $3::uuid`, [seriesWinnerId, JSON.stringify(dbLogs), currentMatch.id]);
        const loseId = seriesWinnerId === currentMatch.team1_id ? currentMatch.team2_id : currentMatch.team1_id;
        await client.query(`UPDATE public.lobby_teams SET group_wins = group_wins + 1 WHERE id = $1::uuid`, [seriesWinnerId]);
        await client.query(`UPDATE public.lobby_teams SET group_losses = group_losses + 1 WHERE id = $1::uuid`, [loseId]);
    }

    if (emitEvent) {
        const newState = await getLobbyStateData(client, lobbyId);
        io.to(lobbyId).emit('match_simulated_event', { 
            group: matchTypeTranslated, team1: name1, team2: name2,
            team1_id: currentMatch.team1_id, team2_id: currentMatch.team2_id,
            t1_user_id: currentMatch.t1_user_id, t2_user_id: currentMatch.t2_user_id,
            t1_players: team1Stats.players, t2_players: team2Stats.players,
            winner: gameWinnerName, isBO5: isBO5, gameNumber: gameNumber, score1: wins1, score2: wins2,
            isSeriesFinished: isSeriesFinished, actionLogs: logsArray,
            matchPhase: currentMatch.match_type,
            newState: newState 
        });
    }
    return { isSeriesFinished };
}

export const setupSockets = (io: Server) => {
  io.on('connection', (socket: Socket) => {
    
    socket.on('identify', (payload) => {
        try {
            const data = IdentifySchema.parse(payload);
            socket.join(data.userId);
        } catch (e) { }
    });

    socket.on('send_lobby_invite', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = SendInviteSchema.parse(payload);
            const userRes = await client.query('SELECT username FROM public.users WHERE id = $1', [data.userId]);
            const lobbyRes = await client.query('SELECT invite_code FROM public.lobbies WHERE id = $1', [data.lobbyId]);
            
            if ((userRes.rowCount ?? 0) > 0 && (lobbyRes.rowCount ?? 0) > 0) {
                io.to(data.targetUserId).emit('lobby_invite_received', {
                    lobbyId: data.lobbyId,
                    inviteCode: lobbyRes.rows[0].invite_code,
                    fromUser: userRes.rows[0].username
                });
                callback({ status: 'success' });
            } else {
                throw new Error('Érvénytelen adatok a meghíváshoz.');
            }
        } catch (e: any) {
            callback({ status: 'error', message: e.message });
        } finally {
            client.release();
        }
    });

    socket.on('create_lobby', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = CreateLobbySchema.parse(payload); const code = generateInviteCode(); await client.query('BEGIN');
            const res = await client.query(`INSERT INTO public.lobbies (host_id, name, invite_code) VALUES ($1::uuid, $2, $3) RETURNING id`, [data.userId, 'Worlds Mayhem Draft', code]);
            await client.query(`INSERT INTO public.lobby_teams (lobby_id, user_id, rerolls_left, current_offer) VALUES ($1::uuid, $2::uuid, 3, '[]'::jsonb)`, [res.rows[0].id, data.userId]);
            await client.query('COMMIT'); socket.join(res.rows[0].id); callback({ status: 'success', lobbyId: res.rows[0].id });
        } catch(e: any) { await client.query('ROLLBACK'); callback({status: 'error', message: e.message}); } finally { client.release(); }
    });

    socket.on('join_lobby', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = JoinLobbySchema.parse(payload); await client.query('BEGIN');
            const lobbyRes = await client.query('SELECT id FROM public.lobbies WHERE invite_code = $1::varchar', [data.inviteCode]);
            if ((lobbyRes.rowCount ?? 0) === 0) throw new Error('Érvénytelen kód.');
            const lId = lobbyRes.rows[0].id;
            const tCheck = await client.query('SELECT id FROM public.lobby_teams WHERE lobby_id = $1::uuid AND user_id = $2::uuid', [lId, data.userId]);
            if ((tCheck.rowCount ?? 0) === 0) await client.query(`INSERT INTO public.lobby_teams (lobby_id, user_id, rerolls_left, current_offer) VALUES ($1::uuid, $2::uuid, 3, '[]'::jsonb)`, [lId, data.userId]);
            await client.query('COMMIT'); socket.join(lId); callback({ status: 'success', lobbyId: lId }); await broadcastLobbyState(io, lId);
        } catch(e:any) { await client.query('ROLLBACK'); callback({status: 'error', message: e.message}); } finally { client.release(); }
    });

    socket.on('roll_teams', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = RollSchema.parse(payload); await client.query('BEGIN');
            const tRes = await client.query(`SELECT id, rerolls_left, current_offer FROM public.lobby_teams WHERE lobby_id=$1::uuid AND user_id=$2::uuid FOR UPDATE`, [data.lobbyId, data.userId]);
            const state = tRes.rows[0];
            if (JSON.stringify(state.current_offer) !== '[]') { if (state.rerolls_left <= 0) throw new Error('Nincs Rerollod!'); state.rerolls_left -= 1; }
            const rTeams = await client.query(`SELECT team_name, season FROM public.esport_players GROUP BY team_name, season ORDER BY RANDOM() LIMIT 3`);
            const offer = [];
            for (const t of rTeams.rows) {
                const pRes = await client.query(`SELECT id, name, ingame_role, player_rating, cspm, dpm, vspm, kda, kp_percentage, country FROM public.esport_players WHERE team_name=$1::varchar AND season=$2::integer`, [t.team_name, t.season]);
                const teamCountry = pRes.rows.length > 0 ? pRes.rows[0].country : 'Unknown';
                offer.push({ team: t.team_name, season: t.season, country: teamCountry, players: pRes.rows });
            }
            await client.query(`UPDATE public.lobby_teams SET current_offer=$1::jsonb, rerolls_left=$2::integer WHERE id=$3::uuid`, [JSON.stringify(offer), state.rerolls_left, state.id]);
            await client.query('COMMIT'); callback({ status: 'success', data: { offer, rerollsLeft: state.rerolls_left } });
        } catch(e:any) { await client.query('ROLLBACK'); callback({status: 'error', message: e.message}); } finally { client.release(); }
    });

    socket.on('pick_player', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = PickSchema.parse(payload); const col = RoleColumnMap[data.role]; await client.query('BEGIN');
            const tRes = await client.query(`SELECT id, current_offer, ${col} AS pick FROM public.lobby_teams WHERE lobby_id=$1::uuid AND user_id=$2::uuid FOR UPDATE`, [data.lobbyId, data.userId]);
            if(tRes.rows[0].pick !== null) throw new Error('Foglalt pozíció!');
            await client.query(`UPDATE public.lobby_teams SET ${col}=$1::uuid, current_offer='[]'::jsonb WHERE id=$2::uuid`, [data.playerId, tRes.rows[0].id]);
            await client.query('COMMIT'); callback({ status: 'success' }); await broadcastLobbyState(io, data.lobbyId);
        } catch(e:any) { await client.query('ROLLBACK'); callback({status: 'error', message: e.message}); } finally { client.release(); }
    });

    socket.on('toggle_ready', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = ReadySchema.parse(payload); await client.query('BEGIN');
            await client.query(`UPDATE public.lobby_teams SET is_ready=TRUE WHERE lobby_id=$1::uuid AND user_id=$2::uuid`, [data.lobbyId, data.userId]);
            const pendingRes = await client.query(`SELECT count(*) FROM public.lobby_teams WHERE lobby_id=$1::uuid AND bot_name IS NULL AND is_ready=FALSE`, [data.lobbyId]);
            if ((pendingRes.rowCount ?? 0) > 0 && parseInt(pendingRes.rows[0].count) === 0) {
                await client.query(`UPDATE public.lobbies SET status='SIMULATING' WHERE id=$1::uuid`, [data.lobbyId]);
                const hRes = await client.query(`SELECT count(*) FROM public.lobby_teams WHERE lobby_id=$1::uuid AND bot_name IS NULL`, [data.lobbyId]);
                for (let i=1; i<= (16 - parseInt(hRes.rows[0].count)); i++) {
                    await client.query(`INSERT INTO public.lobby_teams (lobby_id, bot_name, is_ready, top_player_id, jng_player_id, mid_player_id, adc_player_id, sup_player_id) VALUES ($1::uuid, $2::varchar, TRUE, (SELECT id FROM public.esport_players WHERE ingame_role='TOP' ORDER BY RANDOM() LIMIT 1), (SELECT id FROM public.esport_players WHERE ingame_role='JUNGLE' ORDER BY RANDOM() LIMIT 1), (SELECT id FROM public.esport_players WHERE ingame_role='MID' ORDER BY RANDOM() LIMIT 1), (SELECT id FROM public.esport_players WHERE ingame_role='ADC' ORDER BY RANDOM() LIMIT 1), (SELECT id FROM public.esport_players WHERE ingame_role='SUPPORT' ORDER BY RANDOM() LIMIT 1))`, [data.lobbyId, `Bot ${i}`]);
                }
                const tRes = await client.query(`SELECT id FROM public.lobby_teams WHERE lobby_id=$1::uuid ORDER BY RANDOM()`, [data.lobbyId]);
                const teams = tRes.rows.map(r=>r.id); const groups = ['A','B','C','D'];
                for (let i=0; i<16; i++) { await client.query(`UPDATE public.lobby_teams SET group_name=$1::varchar WHERE id=$2::uuid`, [groups[Math.floor(i/4)], teams[i]]); }
                let mo = 1;
                for (const g of groups) {
                    const gtRes = await client.query(`SELECT id FROM public.lobby_teams WHERE lobby_id=$1::uuid AND group_name=$2::varchar`, [data.lobbyId, g]);
                    const gt = gtRes.rows.map(r=>r.id); const pairs = [[0,1],[2,3],[0,2],[1,3],[0,3],[1,2]];
                    for (const p of pairs) { await client.query(`INSERT INTO public.matches (lobby_id, team1_id, team2_id, match_type, match_order) VALUES ($1::uuid,$2::uuid,$3::uuid,'GROUP',$4::integer)`, [data.lobbyId, gt[p[0]], gt[p[1]], mo++]); }
                }
            }
            await client.query('COMMIT'); callback({status:'success'}); await broadcastLobbyState(io, data.lobbyId);
        } catch(e:any) { await client.query('ROLLBACK'); callback({status:'error', message: e.message}); } finally { client.release(); }
    });

    socket.on('next_match_step', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = NextMatchSchema.parse(payload);
            const lCheck = await pool.query('SELECT host_id FROM public.lobbies WHERE id=$1::uuid', [data.lobbyId]);
            if (lCheck.rows[0].host_id !== data.userId) throw new Error('Nincs jogosultságod.');

            await client.query('BEGIN');
            const matchRes = await client.query(`
                SELECT m.id, m.team1_id, m.team2_id, m.match_order, m.match_type, m.match_logs,
                       u1.username as t1_user, t1.bot_name as t1_bot, t1.group_name as group_name, t1.user_id as t1_user_id,
                       u2.username as t2_user, t2.bot_name as t2_bot, t2.user_id as t2_user_id
                FROM public.matches m
                JOIN public.lobby_teams t1 ON m.team1_id = t1.id LEFT JOIN public.users u1 ON t1.user_id = u1.id
                JOIN public.lobby_teams t2 ON m.team2_id = t2.id LEFT JOIN public.users u2 ON t2.user_id = u2.id
                WHERE m.lobby_id = $1::uuid AND m.status = 'PENDING' ORDER BY m.match_order ASC LIMIT 1
            `, [data.lobbyId]);

            if ((matchRes.rowCount ?? 0) === 0) {
                const phaseRes = await client.query(`SELECT match_type, MAX(match_order) as max_order FROM public.matches WHERE lobby_id=$1::uuid GROUP BY match_type ORDER BY max_order DESC LIMIT 1`, [data.lobbyId]);
                if ((phaseRes.rowCount ?? 0) === 0) throw new Error("Nincsenek meccsek.");
                const currentPhase = phaseRes.rows[0].match_type;
                let nextOrder = parseInt(phaseRes.rows[0].max_order) + 1;

                if (currentPhase === 'GROUP') {
                    const tRes = await client.query(`SELECT id, group_name FROM public.lobby_teams WHERE lobby_id=$1::uuid ORDER BY group_wins DESC, group_losses ASC, id ASC`, [data.lobbyId]);
                    const gA = tRes.rows.filter(t=>t.group_name==='A'); const gB = tRes.rows.filter(t=>t.group_name==='B');
                    const gC = tRes.rows.filter(t=>t.group_name==='C'); const gD = tRes.rows.filter(t=>t.group_name==='D');
                    const pairs = [[gA[0].id, gB[1].id], [gC[0].id, gD[1].id], [gB[0].id, gA[1].id], [gD[0].id, gC[1].id]];
                    for (const p of pairs) await client.query(`INSERT INTO public.matches (lobby_id, team1_id, team2_id, match_type, match_order) VALUES ($1::uuid,$2::uuid,$3::uuid,'QUARTER',$4::integer)`, [data.lobbyId, p[0], p[1], nextOrder++]);
                    await client.query('COMMIT'); callback({ status: 'phase_changed', message: 'Kezdődik a negyeddöntő!' });
                    await broadcastLobbyState(io, data.lobbyId); return;
                }
                else if (currentPhase === 'QUARTER') {
                    const qRes = await client.query(`SELECT winner_id FROM public.matches WHERE lobby_id=$1::uuid AND match_type='QUARTER' ORDER BY match_order ASC`, [data.lobbyId]);
                    const w = qRes.rows.map(r=>r.winner_id);
                    await client.query(`INSERT INTO public.matches (lobby_id, team1_id, team2_id, match_type, match_order) VALUES ($1::uuid,$2::uuid,$3::uuid,'SEMI',$4::integer)`, [data.lobbyId, w[0], w[1], nextOrder++]);
                    await client.query(`INSERT INTO public.matches (lobby_id, team1_id, team2_id, match_type, match_order) VALUES ($1::uuid,$2::uuid,$3::uuid,'SEMI',$4::integer)`, [data.lobbyId, w[2], w[3], nextOrder++]);
                    await client.query('COMMIT'); callback({ status: 'phase_changed', message: 'Kezdődik az elődöntő!' });
                    await broadcastLobbyState(io, data.lobbyId); return;
                }
                else if (currentPhase === 'SEMI') {
                    const sRes = await client.query(`SELECT winner_id FROM public.matches WHERE lobby_id=$1::uuid AND match_type='SEMI' ORDER BY match_order ASC`, [data.lobbyId]);
                    const w = sRes.rows.map(r=>r.winner_id);
                    await client.query(`INSERT INTO public.matches (lobby_id, team1_id, team2_id, match_type, match_order) VALUES ($1::uuid,$2::uuid,$3::uuid,'FINAL',$4::integer)`, [data.lobbyId, w[0], w[1], nextOrder++]);
                    await client.query('COMMIT'); callback({ status: 'phase_changed', message: 'Kezdődik a nagydöntő!' });
                    await broadcastLobbyState(io, data.lobbyId); return;
                }
                else if (currentPhase === 'FINAL') {
                    await client.query(`UPDATE public.lobbies SET status = 'FINISHED' WHERE id = $1::uuid`, [data.lobbyId]);
                    
                    const allTeamsRes = await client.query(`
                        SELECT lt.id, lt.user_id, lt.bot_name, u.username, lt.group_wins,
                               p_top.name AS top_name, p_jng.name AS jng_name, p_mid.name AS mid_name, p_adc.name AS adc_name, p_sup.name AS sup_name
                        FROM public.lobby_teams lt 
                        LEFT JOIN public.users u ON lt.user_id = u.id 
                        LEFT JOIN public.esport_players p_top ON lt.top_player_id = p_top.id
                        LEFT JOIN public.esport_players p_jng ON lt.jng_player_id = p_jng.id
                        LEFT JOIN public.esport_players p_mid ON lt.mid_player_id = p_mid.id
                        LEFT JOIN public.esport_players p_adc ON lt.adc_player_id = p_adc.id
                        LEFT JOIN public.esport_players p_sup ON lt.sup_player_id = p_sup.id
                        WHERE lt.lobby_id = $1::uuid 
                        ORDER BY lt.group_wins DESC, lt.group_losses ASC, lt.id ASC
                    `, [data.lobbyId]);
                    
                    const allTeams = allTeamsRes.rows;
                    const bMatchesRes = await client.query(`SELECT team1_id, team2_id, winner_id, match_type FROM public.matches WHERE lobby_id = $1::uuid AND match_type IN ('QUARTER', 'SEMI', 'FINAL')`, [data.lobbyId]);
                    const bMatches = bMatchesRes.rows;

                    const finalMatch = bMatches.find(m => m.match_type === 'FINAL');
                    const champId = finalMatch.winner_id;
                    const runnerUpId = finalMatch.team1_id === champId ? finalMatch.team2_id : finalMatch.team1_id;

                    const semiMatches = bMatches.filter(m => m.match_type === 'SEMI');
                    const semiTeams = [...semiMatches.map(m=>m.team1_id), ...semiMatches.map(m=>m.team2_id)];
                    const semiLosers = semiTeams.filter(id => id !== finalMatch.team1_id && id !== finalMatch.team2_id);

                    const qfMatches = bMatches.filter(m => m.match_type === 'QUARTER');
                    const qfTeams = [...qfMatches.map(m=>m.team1_id), ...qfMatches.map(m=>m.team2_id)];
                    const qfLosers = qfTeams.filter(id => !semiTeams.includes(id));

                    const groupLosers = allTeams.filter(t => !qfTeams.includes(t.id));
                    
                    const lobbyInfo = await client.query(`SELECT name FROM public.lobbies WHERE id = $1::uuid`, [data.lobbyId]);
                    const lobbyName = lobbyInfo.rows[0].name;

                    for (const team of allTeams) {
                        if (team.user_id) {
                            let rank = 16;
                            if (team.id === champId) {
                                rank = 1;
                                await client.query(`UPDATE public.users SET trophies_count = trophies_count + 1 WHERE id = $1::uuid`, [team.user_id]);
                            }
                            else if (team.id === runnerUpId) rank = 2;
                            else if (semiLosers.includes(team.id)) rank = 3;
                            else if (qfLosers.includes(team.id)) rank = 5;
                            else {
                                const idx = groupLosers.findIndex(t => t.id === team.id);
                                rank = 9 + idx;
                            }

                            const rosterSummary = {
                                top: team.top_name || 'Ismeretlen',
                                jng: team.jng_name || 'Ismeretlen',
                                mid: team.mid_name || 'Ismeretlen',
                                adc: team.adc_name || 'Ismeretlen',
                                sup: team.sup_name || 'Ismeretlen'
                            };

                            await client.query(`
                                INSERT INTO public.match_history (user_id, lobby_name, final_position, roster_summary)
                                VALUES ($1::uuid, $2, $3, $4::jsonb)
                            `, [team.user_id, lobbyName, rank, JSON.stringify(rosterSummary)]);
                        }
                    }

                    const getTName = (id: string) => { const t = allTeams.find(x=>x.id===id); return t ? (t.username || t.bot_name) : 'Ismeretlen'; };

                    const standings = [
                        { rank: '1.', name: getTName(champId), rankColor: 'text-yellow-400 text-xl', nameColor: 'text-yellow-400 font-black text-xl' },
                        { rank: '2.', name: getTName(runnerUpId), rankColor: 'text-slate-300 text-lg', nameColor: 'text-slate-200 font-bold text-lg' },
                        ...semiLosers.map(id => ({ rank: 'Top 4', name: getTName(id), rankColor: 'text-amber-600', nameColor: 'text-amber-500 font-semibold' })),
                        ...qfLosers.map(id => ({ rank: 'Top 8', name: getTName(id), rankColor: 'text-slate-500', nameColor: 'text-slate-300' })),
                        ...groupLosers.map((t,i) => ({ rank: `${9+i}.`, name: t.username || t.bot_name, rankColor: 'text-slate-600 text-xs', nameColor: 'text-slate-500 text-sm' }))
                    ];
                    
                    const finalState = await getLobbyStateData(client, data.lobbyId);
                    await client.query('COMMIT');
                    
                    io.to(data.lobbyId).emit('tournament_winner', { winner: getTName(champId), standings: standings, newState: finalState });
                    callback({ status: 'finished' }); return;
                }
            }
            await executeMatchSimulation(client, matchRes.rows[0], io, data.lobbyId, true);
            await client.query('COMMIT'); callback({ status: 'success' });
        } catch (error: any) { await client.query('ROLLBACK'); callback({ status: 'error', message: error.message }); } finally { client.release(); }
    });

    socket.on('fast_forward_matches', async (payload, callback) => {
        const client = await pool.connect();
        try {
            const data = FastForwardSchema.parse(payload);
            const lCheck = await pool.query('SELECT host_id FROM public.lobbies WHERE id=$1::uuid', [data.lobbyId]);
            if (lCheck.rows[0].host_id !== data.userId) throw new Error('Nincs jogosultságod.');

            await client.query('BEGIN');

            if (data.mode === 'bo5') {
                const matchRes = await client.query(`
                    SELECT m.id, m.team1_id, m.team2_id, m.match_order, m.match_type, m.match_logs,
                           u1.username as t1_user, t1.bot_name as t1_bot, t1.group_name as group_name, t1.user_id as t1_user_id,
                           u2.username as t2_user, t2.bot_name as t2_bot, t2.user_id as t2_user_id
                    FROM public.matches m
                    JOIN public.lobby_teams t1 ON m.team1_id = t1.id LEFT JOIN public.users u1 ON t1.user_id = u1.id
                    JOIN public.lobby_teams t2 ON m.team2_id = t2.id LEFT JOIN public.users u2 ON t2.user_id = u2.id
                    WHERE m.lobby_id = $1::uuid AND m.status = 'PENDING' AND m.match_type IN ('QUARTER', 'SEMI', 'FINAL')
                    ORDER BY m.match_order ASC LIMIT 1
                `, [data.lobbyId]);

                if ((matchRes.rowCount ?? 0) === 0) throw new Error("Nincs szimulálható BO5 mérkőzés.");

                let currentMatch = matchRes.rows[0];
                let isFinished = false;
                
                while (!isFinished) {
                    const simRes = await executeMatchSimulation(client, currentMatch, io, data.lobbyId, false);
                    isFinished = simRes.isSeriesFinished;
                    if (!isFinished) {
                        const updatedMatch = await client.query(`SELECT match_logs FROM public.matches WHERE id = $1::uuid`, [currentMatch.id]);
                        currentMatch.match_logs = updatedMatch.rows[0].match_logs;
                    }
                }
                
                await client.query('COMMIT');
                const newState = await getLobbyStateData(client, data.lobbyId);
                io.to(data.lobbyId).emit('fast_forward_complete', { message: `Teljes BO5 széria sikeresen lejátszva!`, newState: newState });
                callback({ status: 'success' });
            } else {
                let limit = 24;
                if (data.mode === 'group') {
                    const pendingMatch = await client.query(`
                        SELECT m.match_order 
                        FROM public.matches m 
                        WHERE m.lobby_id = $1::uuid AND m.status = 'PENDING' AND m.match_type = 'GROUP' 
                        ORDER BY m.match_order ASC LIMIT 1
                    `, [data.lobbyId]);

                    if ((pendingMatch.rowCount ?? 0) > 0) {
                        const mo = parseInt(pendingMatch.rows[0].match_order);
                        limit = 6 - ((mo - 1) % 6);
                        if (limit === 0) limit = 6;
                    }
                }

                const matchRes = await client.query(`
                    SELECT m.id, m.team1_id, m.team2_id, m.match_order, m.match_type, m.match_logs,
                           u1.username as t1_user, t1.bot_name as t1_bot, t1.group_name as group_name, t1.user_id as t1_user_id,
                           u2.username as t2_user, t2.bot_name as t2_bot, t2.user_id as t2_user_id
                    FROM public.matches m
                    JOIN public.lobby_teams t1 ON m.team1_id = t1.id LEFT JOIN public.users u1 ON t1.user_id = u1.id
                    JOIN public.lobby_teams t2 ON m.team2_id = t2.id LEFT JOIN public.users u2 ON t2.user_id = u2.id
                    WHERE m.lobby_id = $1::uuid AND m.status = 'PENDING' AND m.match_type = 'GROUP'
                    ORDER BY m.match_order ASC LIMIT $2::integer
                `, [data.lobbyId, limit]);

                if ((matchRes.rowCount ?? 0) === 0) throw new Error("Nincs több szimulálható csoportmérkőzés.");

                const toSimulate = matchRes.rows;
                for (const match of toSimulate) { await executeMatchSimulation(client, match, io, data.lobbyId, false); }
                await client.query('COMMIT');
                
                const newState = await getLobbyStateData(client, data.lobbyId);
                io.to(data.lobbyId).emit('fast_forward_complete', { message: `${toSimulate.length} csoportmérkőzés sikeresen szimulálva.`, newState: newState });
                callback({ status: 'success' });
            }
        } catch (error: any) { await client.query('ROLLBACK'); callback({ status: 'error', message: error.message }); } finally { client.release(); }
    });

  });
};