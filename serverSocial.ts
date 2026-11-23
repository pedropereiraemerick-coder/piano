import crypto from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import fs from 'fs';
import type { Server as HttpServer } from 'http';
import path from 'path';
import { WebSocket, WebSocketServer } from 'ws';

export type ProfileVisibility = 'todos' | 'amigos' | 'privado';
export type FriendRequestPolicy = 'todos' | 'ninguem';
export type MessagePolicy = 'todos' | 'amigos' | 'ninguem';

export interface StoredPrivacy {
  profileVisibility: ProfileVisibility;
  allowFriendRequests: FriendRequestPolicy;
  allowMessagesFrom: MessagePolicy;
  showLibrary: boolean;
  showScores: boolean;
  showRecordings: boolean;
  showActivity: boolean;
  showStats: boolean;
}

export interface StoredShowcase {
  favorites: Array<Record<string, unknown>>;
  wantToLearn: Array<Record<string, unknown>>;
  studied: Array<Record<string, unknown>>;
  playlists: Array<Record<string, unknown>>;
  scores: Array<Record<string, unknown>>;
  recordings: Array<Record<string, unknown>>;
  activity: Array<Record<string, unknown>>;
  stats: {
    songsPracticed: number;
    songsCompleted: number;
    favoritesCount: number;
    recordingsCount: number;
  };
}

export interface StoredUser {
  id: string;
  handle: string;
  displayName: string;
  bio: string;
  avatarColor: string;
  avatarUrl?: string;
  bannerUrl?: string;
  bannerPreset: string;
  accentColor: string;
  cardEffect: string;
  animationsEnabled: boolean;
  instrumentLevel: 'Iniciante' | 'Intermediário' | 'Avançado';
  favoriteGenre: string;
  featuredSongTitle?: string;
  privacy: StoredPrivacy;
  showcase: StoredShowcase;
  googleSub?: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface StoredFriendRequest {
  id: string;
  fromUserId: string;
  toUserId: string;
  status: 'pending' | 'accepted' | 'declined';
  createdAt: number;
  updatedAt: number;
}

export interface StoredFriendship {
  id: string;
  userA: string;
  userB: string;
  createdAt: number;
}

export interface StoredChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  recipientId: string;
  type: 'text' | 'song' | 'recording' | 'link' | 'voice' | 'image';
  text: string;
  songPayload?: Record<string, unknown>;
  recordingPayload?: Record<string, unknown>;
  linkUrl?: string;
  linkTitle?: string;
  voiceDataUrl?: string;
  voiceDurationMs?: number;
  imageDataUrl?: string;
  createdAt: number;
}

interface SocialDatabase {
  users: Record<string, StoredUser>;
  friendRequests: StoredFriendRequest[];
  friendships: StoredFriendship[];
  messages: StoredChatMessage[];
}

interface AuthedRequest extends Request {
  socialUser?: StoredUser;
}

const STORE_FILE = path.resolve(process.cwd(), '.keyora-social-store.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const VALID_BANNER_PRESETS = new Set([
  'piano-grand',
  'manuscript-glow',
  'midnight-aurora',
  'velvet-rose',
  'royal-violet',
  'champagne-gold',
  'conservatory-slate',
]);

const VALID_CARD_EFFECTS = new Set(['clean', 'glass', 'vinyl-glow', 'staff-lines']);

const DEFAULT_PRIVACY: StoredPrivacy = {
  profileVisibility: 'todos',
  allowFriendRequests: 'todos',
  allowMessagesFrom: 'amigos',
  showLibrary: true,
  showScores: true,
  showRecordings: true,
  showActivity: true,
  showStats: true,
};

const EMPTY_SHOWCASE: StoredShowcase = {
  favorites: [],
  wantToLearn: [],
  studied: [],
  playlists: [],
  scores: [],
  recordings: [],
  activity: [],
  stats: {
    songsPracticed: 0,
    songsCompleted: 0,
    favoritesCount: 0,
    recordingsCount: 0,
  },
};

function loadDb(): SocialDatabase {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const raw = fs.readFileSync(STORE_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<SocialDatabase>;
      return {
        users: parsed.users && typeof parsed.users === 'object' ? parsed.users : {},
        friendRequests: Array.isArray(parsed.friendRequests) ? parsed.friendRequests : [],
        friendships: Array.isArray(parsed.friendships) ? parsed.friendships : [],
        messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      };
    }
  } catch {
    // fallback to clean empty DB
  }
  return {
    users: {},
    friendRequests: [],
    friendships: [],
    messages: [],
  };
}

let db: SocialDatabase = loadDb();

function saveDb(): void {
  const tmpFile = `${STORE_FILE}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmpFile, JSON.stringify(db), 'utf8');
    fs.renameSync(tmpFile, STORE_FILE);
  } catch (err) {
    console.error('Failed to persist social database:', err);
  }
}

function normalizeHandle(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^@+/, '')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 24);
}

function isValidHandle(handle: string): boolean {
  return /^[a-z0-9_]{3,24}$/.test(handle);
}

function sanitizeHexColor(raw: unknown, fallback: string): string {
  if (typeof raw === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.trim())) {
    return raw.trim();
  }
  return fallback;
}

function generateUniqueHandle(displayName?: string, email?: string): string {
  const emailPrefix = typeof email === 'string' ? email.split('@')[0] : '';
  const base = normalizeHandle(displayName || emailPrefix || 'pianista');
  const seed = base.length >= 3 ? base.slice(0, 18) : 'pianista';
  const taken = new Set(Object.values(db.users).map((u) => u.handle));
  if (!taken.has(seed)) return seed;
  for (let i = 2; i <= 999; i += 1) {
    const candidate = `${seed.slice(0, 20)}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${seed.slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`;
}

function sanitizeImageRef(raw: unknown, maxBytes: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  if (/^\/src\/assets\/images\/[a-zA-Z0-9_.-]+\.(jpg|jpeg|png|webp|svg)$/.test(trimmed)) {
    return trimmed;
  }
  if (
    /^https:\/\/([a-z0-9-]+\.)*googleusercontent\.com\/[^\s"'<>]{4,320}$/i.test(trimmed) &&
    trimmed.length <= 360
  ) {
    return trimmed;
  }
  if (
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(trimmed) &&
    trimmed.length <= maxBytes
  ) {
    return trimmed;
  }
  return undefined;
}

function sanitizeAudioDataUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (
    /^data:audio\/(webm|ogg|mp4|mpeg|wav|aac)(;[a-z0-9=.-]+)*;base64,[A-Za-z0-9+/=]+$/i.test(
      trimmed
    ) &&
    trimmed.length <= 650_000
  ) {
    return trimmed;
  }
  return undefined;
}

function sanitizeExternalHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const u = new URL(raw.trim());
    if (u.protocol === 'http:' || u.protocol === 'https:') {
      return u.toString().slice(0, 500);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function sanitizePrivacy(raw: unknown, current?: StoredPrivacy): StoredPrivacy {
  const base = current || DEFAULT_PRIVACY;
  if (!raw || typeof raw !== 'object') return { ...base };
  const p = raw as Record<string, unknown>;
  const vis =
    p.profileVisibility === 'todos' ||
    p.profileVisibility === 'amigos' ||
    p.profileVisibility === 'privado'
      ? p.profileVisibility
      : base.profileVisibility;
  const reqPolicy =
    p.allowFriendRequests === 'todos' || p.allowFriendRequests === 'ninguem'
      ? p.allowFriendRequests
      : base.allowFriendRequests;
  const msgPolicy =
    p.allowMessagesFrom === 'todos' ||
    p.allowMessagesFrom === 'amigos' ||
    p.allowMessagesFrom === 'ninguem'
      ? p.allowMessagesFrom
      : base.allowMessagesFrom;

  return {
    profileVisibility: vis,
    allowFriendRequests: reqPolicy,
    allowMessagesFrom: msgPolicy,
    showLibrary: typeof p.showLibrary === 'boolean' ? p.showLibrary : base.showLibrary,
    showScores: typeof p.showScores === 'boolean' ? p.showScores : base.showScores,
    showRecordings: typeof p.showRecordings === 'boolean' ? p.showRecordings : base.showRecordings,
    showActivity: typeof p.showActivity === 'boolean' ? p.showActivity : base.showActivity,
    showStats: typeof p.showStats === 'boolean' ? p.showStats : base.showStats,
  };
}

function sanitizeShowcase(raw: unknown): StoredShowcase {
  if (!raw || typeof raw !== 'object') return structuredClone(EMPTY_SHOWCASE);
  const s = raw as Record<string, unknown>;
  const safeArray = (val: unknown, limit: number): Array<Record<string, unknown>> =>
    Array.isArray(val)
      ? val
          .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
          .slice(0, limit)
      : [];

  const rawStats = (s.stats && typeof s.stats === 'object' ? s.stats : {}) as Record<string, unknown>;

  return {
    favorites: safeArray(s.favorites, 30),
    wantToLearn: safeArray(s.wantToLearn, 30),
    studied: safeArray(s.studied, 30),
    playlists: safeArray(s.playlists, 20),
    scores: safeArray(s.scores, 20).map((sc) => ({
      ...sc,
      events: Array.isArray(sc.events) ? sc.events.slice(0, 450) : [],
    })),
    recordings: safeArray(s.recordings, 20).map((rec) => ({
      ...rec,
      notes: Array.isArray(rec.notes) ? rec.notes.slice(0, 900) : [],
    })),
    activity: safeArray(s.activity, 25),
    stats: {
      songsPracticed: Math.max(0, Number(rawStats.songsPracticed) || 0),
      songsCompleted: Math.max(0, Number(rawStats.songsCompleted) || 0),
      favoritesCount: Math.max(0, Number(rawStats.favoritesCount) || 0),
      recordingsCount: Math.max(0, Number(rawStats.recordingsCount) || 0),
    },
  };
}

function hashPassword(password: string, salt?: string): { salt: string; hash: string } {
  const actualSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, actualSalt, 64).toString('hex');
  return { salt: actualSalt, hash };
}

function verifyPassword(password: string, salt: string, storedHash: string): boolean {
  try {
    const derived = crypto.scryptSync(password, salt, 64);
    const storedBuf = Buffer.from(storedHash, 'hex');
    if (derived.length !== storedBuf.length) return false;
    return crypto.timingSafeEqual(derived, storedBuf);
  } catch {
    return false;
  }
}

function signToken(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ uid: userId, exp: Date.now() + TOKEN_TTL_MS }),
    'utf8'
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token: string): StoredUser | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [payload, sig] = parts;
    const expectedSig = crypto
      .createHmac('sha256', SESSION_SECRET)
      .update(payload)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      uid?: string;
      exp?: number;
    };
    if (!parsed.uid || !parsed.exp || parsed.exp < Date.now()) return null;
    return db.users[parsed.uid] || null;
  } catch {
    return null;
  }
}

function getConversationId(userA: string, userB: string): string {
  return userA < userB ? `${userA}__${userB}` : `${userB}__${userA}`;
}

function areFriends(userA: string, userB: string): boolean {
  if (!userA || !userB || userA === userB) return false;
  const pairId = getConversationId(userA, userB);
  return db.friendships.some((f) => f.id === pairId);
}

function getRelationship(
  viewerId: string | null,
  targetId: string
): {
  status: 'self' | 'friend' | 'request_sent' | 'request_received' | 'none';
  requestId?: string;
} {
  if (!viewerId) return { status: 'none' };
  if (viewerId === targetId) return { status: 'self' };
  if (areFriends(viewerId, targetId)) return { status: 'friend' };

  const pending = db.friendRequests.find(
    (r) =>
      r.status === 'pending' &&
      ((r.fromUserId === viewerId && r.toUserId === targetId) ||
        (r.fromUserId === targetId && r.toUserId === viewerId))
  );
  if (pending) {
    return {
      status: pending.fromUserId === viewerId ? 'request_sent' : 'request_received',
      requestId: pending.id,
    };
  }
  return { status: 'none' };
}

function isUserOnline(userId: string, socketsByUser: Map<string, Set<WebSocket>>): boolean {
  const set = socketsByUser.get(userId);
  if (!set || set.size === 0) return false;
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

function sanitizeUserForViewer(
  target: StoredUser,
  viewerId: string | null,
  socketsByUser: Map<string, Set<WebSocket>>
) {
  const rel = getRelationship(viewerId, target.id);
  const isSelf = rel.status === 'self';
  const isFriend = rel.status === 'friend';

  const visibleByPrivacy =
    isSelf ||
    target.privacy.profileVisibility === 'todos' ||
    (target.privacy.profileVisibility === 'amigos' && isFriend);

  const canMessage =
    !isSelf &&
    viewerId !== null &&
    (target.privacy.allowMessagesFrom === 'todos' ||
      (target.privacy.allowMessagesFrom === 'amigos' && isFriend));

  const canSendFriendRequest =
    !isSelf &&
    viewerId !== null &&
    rel.status === 'none' &&
    target.privacy.allowFriendRequests === 'todos';

  const showcase: Partial<StoredShowcase> = {};
  if (visibleByPrivacy) {
    if (isSelf || target.privacy.showLibrary) {
      showcase.favorites = target.showcase.favorites;
      showcase.wantToLearn = target.showcase.wantToLearn;
      showcase.playlists = target.showcase.playlists;
    }
    if (isSelf || target.privacy.showScores) {
      showcase.scores = target.showcase.scores;
    }
    if (isSelf || target.privacy.showRecordings) {
      showcase.recordings = target.showcase.recordings;
    }
    if (isSelf || target.privacy.showActivity) {
      showcase.studied = target.showcase.studied;
      showcase.activity = target.showcase.activity;
    }
    if (isSelf || target.privacy.showStats) {
      showcase.stats = target.showcase.stats;
    }
  }

  return {
    id: target.id,
    handle: target.handle,
    displayName: target.displayName,
    bio: visibleByPrivacy ? target.bio : '',
    avatarColor: target.avatarColor,
    avatarUrl: target.avatarUrl,
    bannerUrl: visibleByPrivacy ? target.bannerUrl : undefined,
    bannerPreset: visibleByPrivacy ? target.bannerPreset : 'conservatory-slate',
    accentColor: target.accentColor,
    cardEffect: visibleByPrivacy ? target.cardEffect : 'clean',
    animationsEnabled: visibleByPrivacy ? target.animationsEnabled : false,
    instrumentLevel: visibleByPrivacy ? target.instrumentLevel : 'Iniciante',
    favoriteGenre: visibleByPrivacy ? target.favoriteGenre : undefined,
    featuredSongTitle: visibleByPrivacy ? target.featuredSongTitle : undefined,
    privacy: isSelf
      ? target.privacy
      : {
          ...DEFAULT_PRIVACY,
          profileVisibility: target.privacy.profileVisibility,
          allowFriendRequests: target.privacy.allowFriendRequests,
          allowMessagesFrom: target.privacy.allowMessagesFrom,
        },
    isRestricted: !visibleByPrivacy,
    relationship: rel.status,
    friendRequestId: rel.requestId,
    canMessage,
    canSendFriendRequest,
    isOnline: isSelf || isFriend ? isUserOnline(target.id, socketsByUser) : false,
    showcase: visibleByPrivacy ? showcase : undefined,
    createdAt: target.createdAt,
  };
}

function authMiddleware(req: AuthedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Autenticação necessária para esta ação.' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  const user = verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'Sessão expirada ou inválida. Entre novamente.' });
    return;
  }
  req.socialUser = user;
  next();
}

function optionalAuthUser(req: Request): StoredUser | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return verifyToken(header.slice('Bearer '.length).trim());
}

export function attachSocialPlatform(app: Express, httpServer: HttpServer): void {
  const socketsByUser = new Map<string, Set<WebSocket>>();
  const wss = new WebSocketServer({ noServer: true });

  function pushToUser(userId: string, event: unknown): void {
    const sockets = socketsByUser.get(userId);
    if (!sockets) return;
    const payload = JSON.stringify(event);
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(payload);
      }
    }
  }

  function broadcastPresence(userId: string, online: boolean): void {
    const friendIds = db.friendships
      .filter((f) => f.userA === userId || f.userB === userId)
      .map((f) => (f.userA === userId ? f.userB : f.userA));

    for (const fid of friendIds) {
      pushToUser(fid, { type: 'presence:update', userId, isOnline: online });
    }
  }

  httpServer.on('upgrade', (req, socket, head) => {
    const urlPath = (req.url || '').split('?')[0];
    if (urlPath !== '/ws/social') {
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    let authedUserId: string | null = null;

    ws.on('message', (rawData) => {
      try {
        const msg = JSON.parse(rawData.toString()) as { type?: string; token?: string };
        if (msg.type === 'auth' && typeof msg.token === 'string') {
          const user = verifyToken(msg.token);
          if (!user) {
            ws.send(JSON.stringify({ type: 'auth:error', error: 'Token inválido' }));
            ws.close(4001, 'Unauthorized');
            return;
          }
          authedUserId = user.id;
          let set = socketsByUser.get(user.id);
          if (!set) {
            set = new Set();
            socketsByUser.set(user.id, set);
          }
          set.add(ws);
          ws.send(JSON.stringify({ type: 'auth:ok', userId: user.id }));
          broadcastPresence(user.id, true);
        }
      } catch {
        // ignore malformed frames
      }
    });

    ws.on('close', () => {
      if (authedUserId) {
        const set = socketsByUser.get(authedUserId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) {
            socketsByUser.delete(authedUserId);
            broadcastPresence(authedUserId, false);
          }
        }
      }
    });
  });

  // 1. Register social account (@usuario + password)
  app.post('/api/social/auth/register', (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const handle = normalizeHandle(body.handle);
    const displayName =
      typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 40) : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!isValidHandle(handle)) {
      res.status(400).json({
        error: 'O nome de usuário (@usuário) deve ter de 3 a 24 caracteres (letras, números ou _).',
      });
      return;
    }
    if (!displayName) {
      res.status(400).json({ error: 'Informe seu nome de exibição.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
      return;
    }

    const exists = Object.values(db.users).some((u) => u.handle === handle);
    if (exists) {
      res.status(409).json({ error: `O @${handle} já está em uso. Escolha outro identificador.` });
      return;
    }

    const profileInput =
      body.profile && typeof body.profile === 'object'
        ? (body.profile as Record<string, unknown>)
        : {};
    const { salt, hash } = hashPassword(password);
    const now = Date.now();
    const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;

    const newUser: StoredUser = {
      id: userId,
      handle,
      displayName,
      bio: typeof profileInput.bio === 'string' ? profileInput.bio.trim().slice(0, 240) : '',
      avatarColor: sanitizeHexColor(profileInput.avatarColor, '#0d9488'),
      avatarUrl: sanitizeImageRef(profileInput.avatarUrl, 260_000),
      bannerUrl: sanitizeImageRef(profileInput.bannerUrl, 450_000),
      bannerPreset:
        typeof profileInput.bannerPreset === 'string' &&
        VALID_BANNER_PRESETS.has(profileInput.bannerPreset)
          ? profileInput.bannerPreset
          : 'piano-grand',
      accentColor: sanitizeHexColor(profileInput.accentColor, '#0d9488'),
      cardEffect:
        typeof profileInput.cardEffect === 'string' && VALID_CARD_EFFECTS.has(profileInput.cardEffect)
          ? profileInput.cardEffect
          : 'clean',
      animationsEnabled: profileInput.animationsEnabled !== false,
      instrumentLevel:
        profileInput.instrumentLevel === 'Intermediário' || profileInput.instrumentLevel === 'Avançado'
          ? profileInput.instrumentLevel
          : 'Iniciante',
      favoriteGenre:
        typeof profileInput.favoriteGenre === 'string' && profileInput.favoriteGenre.trim()
          ? profileInput.favoriteGenre.trim().slice(0, 40)
          : 'Música clássica',
      featuredSongTitle:
        typeof profileInput.featuredSongTitle === 'string' && profileInput.featuredSongTitle.trim()
          ? profileInput.featuredSongTitle.trim().slice(0, 80)
          : undefined,
      privacy: sanitizePrivacy(profileInput.privacy),
      showcase: sanitizeShowcase(body.showcase),
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: now,
      updatedAt: now,
    };

    db.users[userId] = newUser;
    saveDb();

    const token = signToken(userId);
    res.status(201).json({
      token,
      user: sanitizeUserForViewer(newUser, userId, socketsByUser),
    });
  });

  // 2. Login with @handle + password
  app.post('/api/social/auth/login', (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const handle = normalizeHandle(body.handle);
    const password = typeof body.password === 'string' ? body.password : '';

    const user = Object.values(db.users).find((u) => u.handle === handle);
    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      res.status(401).json({ error: 'Usuário ou senha inválidos.' });
      return;
    }

    const token = signToken(user.id);
    res.json({
      token,
      user: sanitizeUserForViewer(user, user.id, socketsByUser),
      isNewUser: false,
    });
  });

  // 2b. Sign in / first-run provision using verified Google OAuth access token
  app.post('/api/social/auth/google', async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    const googleToken =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length).trim()
        : '';

    if (!googleToken || googleToken.length < 16) {
      res.status(401).json({ error: 'Token de acesso do Google ausente ou inválido.' });
      return;
    }

    let info: {
      sub?: string;
      name?: string;
      given_name?: string;
      email?: string;
      picture?: string;
    };

    try {
      const userinfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${googleToken}` },
        signal: AbortSignal.timeout(8000),
      });

      if (!userinfoRes.ok) {
        res.status(401).json({
          error: 'Não foi possível validar sua sessão Google. Tente entrar novamente.',
        });
        return;
      }

      info = (await userinfoRes.json()) as typeof info;
    } catch {
      res.status(502).json({
        error: 'Falha ao consultar a verificação da conta Google. Tente novamente.',
      });
      return;
    }

    if (typeof info?.sub !== 'string' || !info.sub.trim()) {
      res.status(401).json({ error: 'Identidade Google inválida.' });
      return;
    }

    const googleSub = info.sub.trim();
    const existingUser = Object.values(db.users).find((u) => u.googleSub === googleSub);

    if (existingUser) {
      if (!existingUser.avatarUrl && info.picture) {
        existingUser.avatarUrl = sanitizeImageRef(info.picture, 260_000);
        existingUser.updatedAt = Date.now();
        saveDb();
      }
      const token = signToken(existingUser.id);
      res.json({
        token,
        user: sanitizeUserForViewer(existingUser, existingUser.id, socketsByUser),
        isNewUser: false,
      });
      return;
    }

    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const profileInput =
      body.profile && typeof body.profile === 'object'
        ? (body.profile as Record<string, unknown>)
        : {};

    const rawName =
      (typeof info.name === 'string' && info.name.trim()) ||
      (typeof info.given_name === 'string' && info.given_name.trim()) ||
      (typeof info.email === 'string' && info.email.split('@')[0]) ||
      'Pianista';

    const displayName = rawName.trim().slice(0, 40);
    const handle = generateUniqueHandle(displayName, info.email);
    const now = Date.now();
    const userId = `usr_${crypto.randomBytes(8).toString('hex')}`;
    const { salt, hash } = hashPassword(crypto.randomBytes(32).toString('hex'));

    const newUser: StoredUser = {
      id: userId,
      googleSub,
      handle,
      displayName,
      bio: '',
      avatarColor: sanitizeHexColor(profileInput.avatarColor, '#0d9488'),
      avatarUrl: sanitizeImageRef(info.picture, 260_000),
      bannerUrl: sanitizeImageRef(profileInput.bannerUrl, 450_000),
      bannerPreset:
        typeof profileInput.bannerPreset === 'string' &&
        VALID_BANNER_PRESETS.has(profileInput.bannerPreset)
          ? profileInput.bannerPreset
          : 'piano-grand',
      accentColor: sanitizeHexColor(profileInput.accentColor, '#0d9488'),
      cardEffect:
        typeof profileInput.cardEffect === 'string' && VALID_CARD_EFFECTS.has(profileInput.cardEffect)
          ? profileInput.cardEffect
          : 'clean',
      animationsEnabled: profileInput.animationsEnabled !== false,
      instrumentLevel:
        profileInput.instrumentLevel === 'Intermediário' || profileInput.instrumentLevel === 'Avançado'
          ? profileInput.instrumentLevel
          : 'Iniciante',
      favoriteGenre:
        typeof profileInput.favoriteGenre === 'string' && profileInput.favoriteGenre.trim()
          ? profileInput.favoriteGenre.trim().slice(0, 40)
          : 'Música clássica',
      privacy: sanitizePrivacy(profileInput.privacy),
      showcase: sanitizeShowcase(body.showcase),
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: now,
      updatedAt: now,
    };

    db.users[userId] = newUser;
    saveDb();

    const token = signToken(userId);
    res.status(201).json({
      token,
      user: sanitizeUserForViewer(newUser, userId, socketsByUser),
      isNewUser: true,
    });
  });

  // 3. Get active user
  app.get('/api/social/auth/me', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    res.json({ user: sanitizeUserForViewer(me, me.id, socketsByUser) });
  });

  // 4. Update own profile customization & privacy
  app.put('/api/social/profile', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

    if (typeof body.handle === 'string') {
      const nextHandle = normalizeHandle(body.handle);
      if (!isValidHandle(nextHandle)) {
        res.status(400).json({
          error: 'O @usuário precisa ter entre 3 e 24 caracteres (letras, números ou _).',
        });
        return;
      }
      const conflict = Object.values(db.users).some(
        (u) => u.id !== me.id && u.handle === nextHandle
      );
      if (conflict) {
        res.status(409).json({ error: `O identificador @${nextHandle} já está sendo usado.` });
        return;
      }
      me.handle = nextHandle;
    }

    if (typeof body.displayName === 'string' && body.displayName.trim()) {
      me.displayName = body.displayName.trim().slice(0, 40);
    }
    if (typeof body.bio === 'string') {
      me.bio = body.bio.trim().slice(0, 240);
    }
    if (body.avatarColor !== undefined) {
      me.avatarColor = sanitizeHexColor(body.avatarColor, me.avatarColor);
    }
    if (body.avatarUrl !== undefined) {
      me.avatarUrl = body.avatarUrl ? sanitizeImageRef(body.avatarUrl, 260_000) : undefined;
    }
    if (body.bannerUrl !== undefined) {
      me.bannerUrl = body.bannerUrl ? sanitizeImageRef(body.bannerUrl, 450_000) : undefined;
    }
    if (typeof body.bannerPreset === 'string' && VALID_BANNER_PRESETS.has(body.bannerPreset)) {
      me.bannerPreset = body.bannerPreset;
    }
    if (body.accentColor !== undefined) {
      me.accentColor = sanitizeHexColor(body.accentColor, me.accentColor);
    }
    if (typeof body.cardEffect === 'string' && VALID_CARD_EFFECTS.has(body.cardEffect)) {
      me.cardEffect = body.cardEffect;
    }
    if (typeof body.animationsEnabled === 'boolean') {
      me.animationsEnabled = body.animationsEnabled;
    }
    if (
      body.instrumentLevel === 'Iniciante' ||
      body.instrumentLevel === 'Intermediário' ||
      body.instrumentLevel === 'Avançado'
    ) {
      me.instrumentLevel = body.instrumentLevel;
    }
    if (typeof body.favoriteGenre === 'string') {
      me.favoriteGenre = body.favoriteGenre.trim().slice(0, 40) || 'Música clássica';
    }
    if (body.featuredSongTitle !== undefined) {
      me.featuredSongTitle =
        typeof body.featuredSongTitle === 'string' && body.featuredSongTitle.trim()
          ? body.featuredSongTitle.trim().slice(0, 80)
          : undefined;
    }
    if (body.privacy !== undefined) {
      me.privacy = sanitizePrivacy(body.privacy, me.privacy);
    }
    if (body.showcase !== undefined) {
      me.showcase = sanitizeShowcase(body.showcase);
    }
    me.updatedAt = Date.now();
    saveDb();

    res.json({ user: sanitizeUserForViewer(me, me.id, socketsByUser) });
  });

  // 5. Sync personal library showcase
  app.put('/api/social/showcase', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    me.showcase = sanitizeShowcase(req.body);
    me.updatedAt = Date.now();
    saveDb();
    res.json({ ok: true });
  });

  // 6. Check handle availability
  app.get('/api/social/handles/check', (req: Request, res: Response) => {
    const handle = normalizeHandle(req.query.handle);
    const viewer = optionalAuthUser(req);
    if (!isValidHandle(handle)) {
      res.json({ valid: false, available: false });
      return;
    }
    const existing = Object.values(db.users).find((u) => u.handle === handle);
    res.json({
      valid: true,
      available: !existing || (viewer ? existing.id === viewer.id : false),
    });
  });

  // 7. Search registered users by displayName or @handle
  app.get('/api/social/users/search', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const qRaw = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const qHandle = qRaw.replace(/^@+/, '');

    const matches = Object.values(db.users)
      .filter((u) => u.id !== me.id)
      .filter((u) => {
        const rel = getRelationship(me.id, u.id);
        if (u.privacy.profileVisibility === 'privado' && rel.status !== 'friend') {
          // Private accounts only show up on exact @handle match if accepting friend requests
          return (
            u.privacy.allowFriendRequests === 'todos' &&
            qHandle.length >= 3 &&
            u.handle === qHandle
          );
        }
        if (!qRaw) return true;
        return u.handle.includes(qHandle) || u.displayName.toLowerCase().includes(qRaw);
      })
      .slice(0, 30)
      .map((u) => sanitizeUserForViewer(u, me.id, socketsByUser));

    res.json({ users: matches });
  });

  // 8. View another user's profile (privacy enforced on server!)
  app.get('/api/social/users/:handleOrId', (req: Request, res: Response) => {
    const viewer = optionalAuthUser(req);
    const rawKey = String(req.params.handleOrId || '').trim();
    const handleKey = normalizeHandle(rawKey);
    const target =
      db.users[rawKey] || Object.values(db.users).find((u) => u.handle === handleKey);
    if (!target) {
      res.status(404).json({ error: 'Perfil não encontrado.' });
      return;
    }
    res.json({ user: sanitizeUserForViewer(target, viewer?.id || null, socketsByUser) });
  });

  // 9. Friends & Pending Requests
  app.get('/api/social/friends', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const friends = db.friendships
      .filter((f) => f.userA === me.id || f.userB === me.id)
      .map((f) => (f.userA === me.id ? db.users[f.userB] : db.users[f.userA]))
      .filter((u): u is StoredUser => Boolean(u))
      .map((u) => sanitizeUserForViewer(u, me.id, socketsByUser));

    const incomingRequests = db.friendRequests
      .filter((r) => r.status === 'pending' && r.toUserId === me.id)
      .map((r) => {
        const fromUser = db.users[r.fromUserId];
        if (!fromUser) return null;
        return {
          id: r.id,
          status: r.status,
          createdAt: r.createdAt,
          fromUser: sanitizeUserForViewer(fromUser, me.id, socketsByUser),
          toUser: sanitizeUserForViewer(me, me.id, socketsByUser),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    const outgoingRequests = db.friendRequests
      .filter((r) => r.status === 'pending' && r.fromUserId === me.id)
      .map((r) => {
        const toUser = db.users[r.toUserId];
        if (!toUser) return null;
        return {
          id: r.id,
          status: r.status,
          createdAt: r.createdAt,
          fromUser: sanitizeUserForViewer(me, me.id, socketsByUser),
          toUser: sanitizeUserForViewer(toUser, me.id, socketsByUser),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    res.json({ friends, incomingRequests, outgoingRequests });
  });

  // 10. Send friend request
  app.post('/api/social/friends/request', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const targetUserId =
      req.body && typeof req.body === 'object' ? String((req.body as { targetUserId?: unknown }).targetUserId || '') : '';
    const target = db.users[targetUserId];
    if (!target) {
      res.status(404).json({ error: 'Usuário não encontrado.' });
      return;
    }
    if (target.id === me.id) {
      res.status(400).json({ error: 'Você não pode adicionar a si mesmo.' });
      return;
    }
    if (areFriends(me.id, target.id)) {
      res.status(409).json({ error: 'Vocês já são amigos.' });
      return;
    }
    if (target.privacy.allowFriendRequests === 'ninguem') {
      res.status(403).json({ error: 'Este usuário não está aceitando solicitações de amizade.' });
      return;
    }

    // If reverse pending request exists, accept automatically
    const reverse = db.friendRequests.find(
      (r) => r.status === 'pending' && r.fromUserId === target.id && r.toUserId === me.id
    );
    const now = Date.now();
    if (reverse) {
      reverse.status = 'accepted';
      reverse.updatedAt = now;
      const pairId = getConversationId(me.id, target.id);
      if (!db.friendships.some((f) => f.id === pairId)) {
        db.friendships.push({
          id: pairId,
          userA: me.id < target.id ? me.id : target.id,
          userB: me.id < target.id ? target.id : me.id,
          createdAt: now,
        });
      }
      saveDb();
      pushToUser(target.id, { type: 'friend:updated' });
      pushToUser(me.id, { type: 'friend:updated' });
      res.json({ autoAccepted: true });
      return;
    }

    const existingReq = db.friendRequests.find(
      (r) => r.status === 'pending' && r.fromUserId === me.id && r.toUserId === target.id
    );
    if (existingReq) {
      res.status(409).json({ error: 'Solicitação de amizade já enviada.' });
      return;
    }

    const freq: StoredFriendRequest = {
      id: `freq_${crypto.randomBytes(8).toString('hex')}`,
      fromUserId: me.id,
      toUserId: target.id,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    db.friendRequests.push(freq);
    saveDb();

    pushToUser(target.id, {
      type: 'friend:request',
      fromHandle: me.handle,
      fromDisplayName: me.displayName,
    });
    pushToUser(me.id, { type: 'friend:updated' });

    res.status(201).json({ requestId: freq.id });
  });

  // 11. Accept or decline friend request
  app.post('/api/social/friends/respond', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      requestId?: unknown;
      action?: unknown;
    };
    const requestId = String(body.requestId || '');
    const action = body.action === 'accept' ? 'accept' : body.action === 'decline' ? 'decline' : null;
    if (!action) {
      res.status(400).json({ error: 'Ação inválida.' });
      return;
    }

    const freq = db.friendRequests.find((r) => r.id === requestId && r.status === 'pending');
    if (!freq) {
      res.status(404).json({ error: 'Solicitação não encontrada ou já respondida.' });
      return;
    }

    // Only recipient can accept; sender or recipient can cancel/decline
    if (action === 'accept' && freq.toUserId !== me.id) {
      res.status(403).json({ error: 'Sem permissão para aceitar esta solicitação.' });
      return;
    }
    if (freq.toUserId !== me.id && freq.fromUserId !== me.id) {
      res.status(403).json({ error: 'Sem permissão.' });
      return;
    }

    const now = Date.now();
    freq.status = action === 'accept' ? 'accepted' : 'declined';
    freq.updatedAt = now;

    if (action === 'accept') {
      const pairId = getConversationId(freq.fromUserId, freq.toUserId);
      if (!db.friendships.some((f) => f.id === pairId)) {
        db.friendships.push({
          id: pairId,
          userA: freq.fromUserId < freq.toUserId ? freq.fromUserId : freq.toUserId,
          userB: freq.fromUserId < freq.toUserId ? freq.toUserId : freq.fromUserId,
          createdAt: now,
        });
      }
    }

    saveDb();
    pushToUser(freq.fromUserId, { type: 'friend:updated' });
    pushToUser(freq.toUserId, { type: 'friend:updated' });
    res.json({ ok: true, status: freq.status });
  });

  // 12. Remove friend
  app.delete('/api/social/friends/:friendUserId', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const targetId = String(req.params.friendUserId || '');
    const pairId = getConversationId(me.id, targetId);
    const before = db.friendships.length;
    db.friendships = db.friendships.filter((f) => f.id !== pairId);
    if (db.friendships.length !== before) {
      saveDb();
      pushToUser(targetId, { type: 'friend:updated' });
      pushToUser(me.id, { type: 'friend:updated' });
    }
    res.json({ ok: true });
  });

  // 13. Get private conversation history
  app.get('/api/social/messages/:peerUserId', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const peerId = String(req.params.peerUserId || '');
    const peer = db.users[peerId];
    if (!peer) {
      res.status(404).json({ error: 'Usuário não encontrado.' });
      return;
    }
    const convId = getConversationId(me.id, peerId);
    const list = db.messages
      .filter((m) => m.conversationId === convId)
      .slice(-200);
    res.json({ messages: list });
  });

  // 14. Send private message (text, song/score, recording, link, voice audio)
  app.post('/api/social/messages', authMiddleware, (req: AuthedRequest, res: Response) => {
    const me = req.socialUser!;
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const recipientId = typeof body.recipientId === 'string' ? body.recipientId : '';
    const peer = db.users[recipientId];
    if (!peer) {
      res.status(404).json({ error: 'Destinatário não encontrado.' });
      return;
    }
    if (peer.id === me.id) {
      res.status(400).json({ error: 'Não é possível enviar mensagens para si mesmo.' });
      return;
    }

    const isFriend = areFriends(me.id, peer.id);
    if (peer.privacy.allowMessagesFrom === 'ninguem') {
      res.status(403).json({ error: 'Este usuário desativou o recebimento de mensagens.' });
      return;
    }
    if (peer.privacy.allowMessagesFrom === 'amigos' && !isFriend) {
      res.status(403).json({ error: 'Apenas amigos podem enviar mensagens para este perfil.' });
      return;
    }

    const msgType =
      body.type === 'song' ||
      body.type === 'recording' ||
      body.type === 'link' ||
      body.type === 'voice' ||
      body.type === 'image'
        ? body.type
        : 'text';

    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 2000) : '';
    const linkUrl = msgType === 'link' ? sanitizeExternalHttpUrl(body.linkUrl) : undefined;
    const linkTitle =
      msgType === 'link' && typeof body.linkTitle === 'string'
        ? body.linkTitle.trim().slice(0, 120)
        : undefined;
    const voiceDataUrl = msgType === 'voice' ? sanitizeAudioDataUrl(body.voiceDataUrl) : undefined;
    const imageDataUrl =
      msgType === 'image' ? sanitizeImageRef(body.imageDataUrl, 480_000) : undefined;
    const voiceDurationMs =
      msgType === 'voice' && Number.isFinite(Number(body.voiceDurationMs))
        ? Math.max(200, Math.min(180_000, Number(body.voiceDurationMs)))
        : undefined;

    let songPayload: Record<string, unknown> | undefined;
    if (msgType === 'song' && body.songPayload && typeof body.songPayload === 'object') {
      const sp = body.songPayload as Record<string, unknown>;
      songPayload = {
        ...sp,
        events: Array.isArray(sp.events) ? sp.events.slice(0, 500) : [],
      };
    }

    let recordingPayload: Record<string, unknown> | undefined;
    if (
      msgType === 'recording' &&
      body.recordingPayload &&
      typeof body.recordingPayload === 'object'
    ) {
      const rp = body.recordingPayload as Record<string, unknown>;
      recordingPayload = {
        ...rp,
        notes: Array.isArray(rp.notes) ? rp.notes.slice(0, 1200) : [],
      };
    }

    if (msgType === 'text' && !text) {
      res.status(400).json({ error: 'Escreva uma mensagem antes de enviar.' });
      return;
    }
    if (msgType === 'link' && !linkUrl) {
      res.status(400).json({ error: 'Informe um link http:// ou https:// válido.' });
      return;
    }
    if (msgType === 'voice' && !voiceDataUrl) {
      res.status(400).json({ error: 'Áudio de voz inválido ou maior que o limite permitido.' });
      return;
    }
    if (msgType === 'image' && !imageDataUrl) {
      res.status(400).json({ error: 'Imagem inválida ou maior que o limite permitido.' });
      return;
    }
    if (msgType === 'song' && !songPayload) {
      res.status(400).json({ error: 'Partitura inválida.' });
      return;
    }
    if (msgType === 'recording' && !recordingPayload) {
      res.status(400).json({ error: 'Gravação inválida.' });
      return;
    }

    const newMessage: StoredChatMessage = {
      id: `msg_${crypto.randomBytes(8).toString('hex')}`,
      conversationId: getConversationId(me.id, peer.id),
      senderId: me.id,
      recipientId: peer.id,
      type: msgType,
      text,
      songPayload,
      recordingPayload,
      linkUrl,
      linkTitle,
      voiceDataUrl,
      voiceDurationMs,
      imageDataUrl,
      createdAt: Date.now(),
    };

    db.messages.push(newMessage);
    if (db.messages.length > 5000) {
      db.messages = db.messages.slice(-5000);
    }
    saveDb();

    pushToUser(peer.id, { type: 'chat:message', message: newMessage });
    pushToUser(me.id, { type: 'chat:message', message: newMessage });

    res.status(201).json({ message: newMessage });
  });
}
