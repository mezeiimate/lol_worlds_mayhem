-- Éles adatbázis-séma inicializálása a Worlds Mayhem játékhoz
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 1. Felhasználók és Profilok (Biztonságos Auth háttér)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(100) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    username VARCHAR(50) UNIQUE NOT NULL,
    trophies_count INT DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Barátlista (Relációs kapcsolat)
CREATE TYPE friend_status AS ENUM ('PENDING', 'ACCEPTED');
CREATE TABLE IF NOT EXISTS public.friendships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id_1 UUID REFERENCES public.users(id) ON DELETE CASCADE,
    user_id_2 UUID REFERENCES public.users(id) ON DELETE CASCADE,
    status friend_status DEFAULT 'PENDING',
    action_user_id UUID NOT NULL, -- Ki indította a kérést
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_friendship UNIQUE (user_id_1, user_id_2),
    CONSTRAINT check_user_order CHECK (user_id_1 < user_id_2) -- Duplikációk elkerülése adatbázis szinten
);

-- 3. Történelmi E-sportolók és Csapatok
CREATE TABLE IF NOT EXISTS public.esport_players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(50) NOT NULL,
    ingame_role VARCHAR(20) NOT NULL, -- TOP, JUNGLE, MID, ADC, SUPPORT
    team_name VARCHAR(50) NOT NULL,   -- pl. T1, RNG, FPX
    season INT NOT NULL,              -- pl. 2017, 2024
    player_rating INT NOT NULL,        -- A szimulációhoz szükséges erősség (pl. 85-99)
    country VARCHAR(10)
);

-- 4. Valós idejű Lobbik
CREATE TYPE lobby_status AS ENUM ('LOBBY', 'DRAFTING', 'SIMULATING', 'FINISHED');
CREATE TABLE IF NOT EXISTS public.lobbies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    host_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    invite_code VARCHAR(6) UNIQUE NOT NULL,
    status lobby_status DEFAULT 'LOBBY',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. Lobbi Résztvevők és a TFT-szerű Roll State (Szerveroldali állapotkezelés)
CREATE TABLE IF NOT EXISTS public.lobby_teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lobby_id UUID REFERENCES public.lobbies(id) ON DELETE CASCADE,
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    is_bot BOOLEAN DEFAULT FALSE,
    bot_team_name VARCHAR(50), -- Ha bot, melyik fix történelmi csapatot kapja meg
    rerolls_left INT DEFAULT 3,
    current_offer JSONB DEFAULT '[]'::jsonb, -- A szerver által generált 3 csapat adatai
    top_player_id UUID REFERENCES public.esport_players(id),
    jng_player_id UUID REFERENCES public.esport_players(id),
    mid_player_id UUID REFERENCES public.esport_players(id),
    adc_player_id UUID REFERENCES public.esport_players(id),
    sup_player_id UUID REFERENCES public.esport_players(id),
    CONSTRAINT unique_lobby_user UNIQUE (lobby_id, user_id)
);

-- 6. Meccstörténet és Trófea Napló (Match History & Stats)
CREATE TABLE IF NOT EXISTS public.match_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES public.users(id) ON DELETE CASCADE,
    lobby_name VARCHAR(100) NOT NULL,
    final_position INT NOT NULL, -- Hanyadik helyen végzett (1-8)
    roster_summary JSONB NOT NULL, -- Milyen csapattal játszott
    played_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);