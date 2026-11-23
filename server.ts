import dotenv from 'dotenv';
import express from 'express';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { attachSocialPlatform } from './serverSocial.ts';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const DIST_DIR = path.resolve(process.cwd(), 'dist');
const HAS_BUILT_CLIENT = fs.existsSync(path.join(DIST_DIR, 'index.html'));
const IS_PROD =
  process.env.NODE_ENV === 'production' ||
  (process.env.npm_lifecycle_event !== 'dev' &&
    process.env.NODE_ENV !== 'development' &&
    HAS_BUILT_CLIENT);

const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    })
  : null;

interface RawEventInput {
  measure?: unknown;
  beat?: unknown;
  durationBeats?: unknown;
  midiNotes?: unknown;
  hand?: unknown;
  chordSymbol?: unknown;
  fingering?: unknown;
}

interface RawSearchResult {
  title?: unknown;
  composer?: unknown;
  artist?: unknown;
  mediaTitle?: unknown;
  genre?: unknown;
  difficulty?: unknown;
  keySignature?: unknown;
  timeSignature?: unknown;
  bpm?: unknown;
  pagesCount?: unknown;
  durationLabel?: unknown;
  description?: unknown;
  isPublicDomain?: unknown;
  chordProgression?: unknown;
  events?: unknown;
}

const VALID_GENRES = new Set([
  'Música clássica',
  'Música brasileira',
  'Trilhas sonoras',
  'Música religiosa',
  'Música popular',
  'Música de filmes',
  'Estudos',
]);

function sanitizeHttpUrl(rawUrl: unknown): string | null {
  if (typeof rawUrl !== 'string') return null;
  try {
    const parsed = new URL(rawUrl.trim());
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

function buildExternalSearchLinks(query: string): Array<{ title: string; uri: string }> {
  const q = encodeURIComponent(`${query} piano sheet music pdf`);
  const raw = encodeURIComponent(query);
  return [
    {
      title: `Buscar "${query}" no Google`,
      uri: `https://www.google.com/search?q=${q}`,
    },
    {
      title: `Pesquisar no IMSLP (Domínio Público)`,
      uri: `https://imslp.org/index.php?title=Special:Search&search=${raw}`,
    },
    {
      title: `Pesquisar no MuseScore`,
      uri: `https://musescore.com/sheetmusic?text=${raw}`,
    },
  ];
}

function formatGeminiSearchError(err: unknown): {
  status: number;
  message: string;
} {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  let parsedCode: number | undefined;
  let parsedStatus = '';
  let parsedMessage = raw;

  try {
    const start = raw.indexOf('{');
    if (start >= 0) {
      const parsed = JSON.parse(raw.slice(start)) as {
        error?: { code?: number; status?: string; message?: string };
      };
      if (parsed?.error) {
        parsedCode = parsed.error.code;
        parsedStatus = parsed.error.status || '';
        parsedMessage = parsed.error.message || raw;
      }
    }
  } catch {
    // keep raw message
  }

  const lower = `${parsedStatus} ${parsedMessage}`.toLowerCase();

  if (parsedCode === 429 || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return {
      status: 429,
      message:
        'A cota da chave GEMINI_API_KEY foi atingida no momento. Para pesquisas ilimitadas via Google nesta prévia, atualize a chave em Settings > Secrets ou use os portais externos abaixo.',
    };
  }

  if (
    parsedCode === 401 ||
    parsedCode === 403 ||
    lower.includes('permission_denied') ||
    lower.includes('api_key_invalid') ||
    lower.includes('invalid api key')
  ) {
    return {
      status: 403,
      message:
        'A chave GEMINI_API_KEY configurada não tem permissão ou está inválida. Verifique sua chave no painel Settings > Secrets.',
    };
  }

  if (parsedCode === 404 || lower.includes('not_found')) {
    return {
      status: 404,
      message:
        'O modelo configurado para busca Google não está disponível para esta chave no momento.',
    };
  }

  if (lower.includes('fetch') || lower.includes('network') || lower.includes('enotfound')) {
    return {
      status: 502,
      message:
        'Falha de conexão com os servidores Google. Verifique sua internet e tente novamente.',
    };
  }

  return {
    status: 502,
    message:
      'Não foi possível concluir a consulta no Google agora. Tente novamente em instantes ou use os portais externos abaixo.',
  };
}

function extractJsonObject(rawText: string): { results?: unknown[] } | null {
  const cleaned = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return null;

  try {
    const parsed = JSON.parse(cleaned.slice(firstBrace, lastBrace + 1)) as { results?: unknown[] };
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function pickCoverForGenre(genre: string, idx: number): string {
  if (genre === 'Música clássica') {
    const classicalCovers = [
      '/src/assets/images/cover_beethoven_classical_1795313480381.jpg',
      '/src/assets/images/cover_bach_baroque_1795313480968.jpg',
      '/src/assets/images/cover_debussy_nocturne_1795313481636.jpg',
    ];
    return classicalCovers[idx % classicalCovers.length];
  }
  const generalCovers = [
    '/src/assets/images/hero_sheet_music_1795315021486.jpg',
    '/src/assets/images/hero_grand_piano_1795313481140.jpg',
    '/src/assets/images/card_sheet_reading_1795315022626.jpg',
  ];
  return generalCovers[idx % generalCovers.length];
}

function buildFallbackEvents(chordProgression: string[], timeSignature: [number, number]) {
  const chordMidiMap: Record<string, { bass: number[]; treble: number[] }> = {
    C: { bass: [48, 55], treble: [60, 64, 67] },
    Cm: { bass: [48, 55], treble: [60, 63, 67] },
    D: { bass: [50, 57], treble: [62, 66, 69] },
    Dm: { bass: [50, 57], treble: [62, 65, 69] },
    E: { bass: [40, 47], treble: [64, 68, 71] },
    Em: { bass: [40, 47], treble: [64, 67, 71] },
    F: { bass: [41, 48], treble: [65, 69, 72] },
    Fm: { bass: [41, 48], treble: [65, 68, 72] },
    G: { bass: [43, 50], treble: [59, 62, 67] },
    Gm: { bass: [43, 50], treble: [58, 62, 67] },
    A: { bass: [45, 52], treble: [61, 64, 69] },
    Am: { bass: [45, 52], treble: [60, 64, 69] },
    Bb: { bass: [46, 53], treble: [62, 65, 70] },
    B: { bass: [47, 54], treble: [63, 66, 71] },
    Bm: { bass: [47, 54], treble: [62, 66, 71] },
  };

  const chords = chordProgression.length > 0 ? chordProgression.slice(0, 8) : ['C', 'G', 'Am', 'F'];
  const beatsPerBar = Math.max(2, Math.min(6, timeSignature[0] || 4));
  const events: Array<{
    id: string;
    measure: number;
    beat: number;
    durationBeats: number;
    midiNotes: number[];
    hand: 'direita' | 'esquerda';
    chordSymbol?: string;
  }> = [];

  chords.forEach((rawChord, idx) => {
    const clean = rawChord.replace(/[^A-Gbm#]/g, '').slice(0, 3) || 'C';
    const voicing = chordMidiMap[clean] || chordMidiMap.C;
    const measure = idx + 1;

    events.push({
      id: `g-lh-${measure}-0`,
      measure,
      beat: 0,
      durationBeats: beatsPerBar,
      midiNotes: voicing.bass,
      hand: 'esquerda',
      chordSymbol: rawChord,
    });

    for (let b = 0; b < beatsPerBar; b++) {
      const melodyNote = voicing.treble[b % voicing.treble.length];
      events.push({
        id: `g-rh-${measure}-${b}`,
        measure,
        beat: b,
        durationBeats: 1,
        midiNotes: b === 0 ? voicing.treble : [melodyNote],
        hand: 'direita',
      });
    }
  });

  return events;
}

function sanitizeResults(
  rawResults: unknown[],
  groundingSources: Array<{ title: string; uri: string }>
) {
  return rawResults
    .slice(0, 8)
    .map((item, idx) => {
      const r = (item && typeof item === 'object' ? item : {}) as RawSearchResult;
      const title = typeof r.title === 'string' && r.title.trim() ? r.title.trim() : '';
      if (!title) return null;

      const composer =
        typeof r.composer === 'string' && r.composer.trim()
          ? r.composer.trim()
          : typeof r.artist === 'string' && r.artist.trim()
            ? r.artist.trim()
            : 'Acervo Web';
      const artist =
        typeof r.artist === 'string' && r.artist.trim() ? r.artist.trim() : undefined;
      const mediaTitle =
        typeof r.mediaTitle === 'string' && r.mediaTitle.trim() ? r.mediaTitle.trim() : undefined;
      const rawGenre = typeof r.genre === 'string' ? r.genre.trim() : 'Música popular';
      const genre = VALID_GENRES.has(rawGenre) ? rawGenre : 'Música popular';
      const rawDiff = typeof r.difficulty === 'string' ? r.difficulty.trim() : 'Intermediário';
      const difficulty =
        rawDiff === 'Iniciante' || rawDiff === 'Intermediário' || rawDiff === 'Avançado'
          ? rawDiff
          : 'Intermediário';

      const keySignature =
        typeof r.keySignature === 'string' && r.keySignature.trim()
          ? r.keySignature.trim().slice(0, 24)
          : 'Dó Maior';

      let timeSignature: [number, number] = [4, 4];
      if (Array.isArray(r.timeSignature) && r.timeSignature.length === 2) {
        const num = Number(r.timeSignature[0]);
        const den = Number(r.timeSignature[1]);
        if (Number.isFinite(num) && Number.isFinite(den) && num >= 2 && num <= 12 && [2, 4, 8].includes(den)) {
          timeSignature = [Math.round(num), Math.round(den)];
        }
      }

      const rawBpm = Number(r.bpm);
      const bpm = Number.isFinite(rawBpm) ? Math.max(44, Math.min(210, Math.round(rawBpm))) : 96;

      const rawPages = Number(r.pagesCount);
      const pagesCount = Number.isFinite(rawPages) ? Math.max(1, Math.min(24, Math.round(rawPages))) : 2;

      const durationLabel =
        typeof r.durationLabel === 'string' && /^\d{1,2}:\d{2}$/.test(r.durationLabel.trim())
          ? r.durationLabel.trim()
          : '3:00';

      const isPublicDomain = Boolean(r.isPublicDomain);

      const chordProgression = Array.isArray(r.chordProgression)
        ? r.chordProgression
            .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
            .map((c) => c.trim().slice(0, 14))
            .slice(0, 12)
        : [];

      const sanitizedEvents: Array<{
        id: string;
        measure: number;
        beat: number;
        durationBeats: number;
        midiNotes: number[];
        hand: 'direita' | 'esquerda';
        chordSymbol?: string;
        fingering?: string;
      }> = [];

      if (Array.isArray(r.events)) {
        r.events.slice(0, 160).forEach((rawEv, evIdx) => {
          if (!rawEv || typeof rawEv !== 'object') return;
          const ev = rawEv as RawEventInput;
          const measure = Number(ev.measure);
          const beat = Number(ev.beat);
          const durationBeats = Number(ev.durationBeats);
          if (!Number.isFinite(measure) || measure < 1 || measure > 48) return;
          if (!Number.isFinite(beat) || beat < 0 || beat >= 12) return;
          if (!Number.isFinite(durationBeats) || durationBeats <= 0 || durationBeats > 8) return;

          const midiNotes = Array.isArray(ev.midiNotes)
            ? ev.midiNotes
                .map((n) => Math.round(Number(n)))
                .filter((n) => Number.isFinite(n) && n >= 21 && n <= 108)
                .slice(0, 6)
            : [];
          if (midiNotes.length === 0) return;

          sanitizedEvents.push({
            id: `google-ev-${idx}-${evIdx}`,
            measure: Math.round(measure),
            beat: Math.round(beat * 4) / 4,
            durationBeats: Math.round(durationBeats * 4) / 4,
            midiNotes,
            hand: ev.hand === 'esquerda' ? 'esquerda' : 'direita',
            chordSymbol:
              typeof ev.chordSymbol === 'string' && ev.chordSymbol.trim()
                ? ev.chordSymbol.trim().slice(0, 14)
                : undefined,
            fingering:
              typeof ev.fingering === 'string' && ev.fingering.trim()
                ? ev.fingering.trim().slice(0, 10)
                : undefined,
          });
        });
      }

      const finalEvents =
        sanitizedEvents.length >= 4
          ? sanitizedEvents
          : buildFallbackEvents(chordProgression, timeSignature);

      const description =
        typeof r.description === 'string' && r.description.trim()
          ? r.description.trim()
          : isPublicDomain
            ? `Partitura encontrada via busca Google para ${title} (${composer}).`
            : `Guia harmônico e estudo ao piano para ${title} (${composer}), com fontes externas encontradas no Google.`;

      return {
        id: `google-${slugify(title)}-${idx}-${Date.now().toString(36)}`,
        title,
        composer,
        artist,
        era: genre,
        genre,
        mediaTitle,
        difficulty,
        durationLabel,
        pagesCount,
        bpm,
        timeSignature,
        keySignature,
        source: 'google' as const,
        format: 'interativo' as const,
        events: finalEvents,
        description,
        coverImage: pickCoverForGenre(genre, idx),
        isPublicDomain,
        chordProgression,
        webSources: groundingSources.slice(0, 6),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const httpServer = http.createServer(app);
  attachSocialPlatform(app, httpServer);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, googleSearchEnabled: Boolean(ai), socialEnabled: true });
  });

  app.post('/api/scores/search', async (req, res) => {
    try {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
        query?: unknown;
        category?: unknown;
      };

      const rawQuery = typeof body.query === 'string' ? body.query.trim().slice(0, 140) : '';
      const rawCategory =
        typeof body.category === 'string' ? body.category.trim().slice(0, 60) : 'Todas';

      if (!rawQuery && (!rawCategory || rawCategory === 'Todas')) {
        res.status(400).json({ error: 'Informe o nome de uma música, compositor, artista ou gênero.' });
        return;
      }

      const searchTerm =
        rawQuery ||
        `partituras famosas para piano da categoria ${rawCategory}`;

      if (!ai) {
        res.status(503).json({
          error:
            'Serviço de busca Google temporariamente indisponível: configure GEMINI_API_KEY no painel Settings > Secrets.',
          externalSearchLinks: buildExternalSearchLinks(searchTerm),
        });
        return;
      }

      const categoryHint =
        rawCategory && rawCategory !== 'Todas'
          ? `Foco principal na categoria: "${rawCategory}".`
          : 'Qualquer gênero musical (clássica, brasileira, filmes, séries, jogos, religiosa, popular, jazz, pop, rock).';

      const prompt = [
        `Você é o motor de busca de partituras de piano do KEYORA PIANO conectado ao Google Search.`,
        `Pesquise na web partituras e obras reais de piano correspondentes à busca do usuário: "${searchTerm}".`,
        categoryHint,
        `Regras musicais e de fidelidade:`,
        `1. Retorne entre 4 e 8 resultados reais correspondentes ao que o usuário digitou (ou obras relacionadas ao compositor/filme/jogo/artista pesquisado).`,
        `2. Para cada música, forneça metadados reais verificados: título oficial, compositor, artista/intérprete, obra/filme/série/jogo (se houver), tonalidade, fórmula de compasso [numerador, denominador], BPM aproximado, páginas estimadas, duração, progressão de acordes reais (chordProgression) e classificação isPublicDomain (true apenas para obras comprovadamente em domínio público ou tradicionais, false para músicas modernas protegidas por direitos autorais).`,
        `3. Em "events", gere notas reais para piano em formato MIDI (entre 36 e 84) com mão direita ('direita') e mão esquerda ('esquerda') para os primeiros 8 a 12 compassos:`,
        `   - Se isPublicDomain for true: transcreva a melodia principal fiel e o acompanhamento da obra.`,
        `   - Se isPublicDomain for false: crie um estudo original da base harmônica/acordes reais da música (nunca copie letra ou partitura comercial protegida).`,
        `4. Responda EXCLUSIVAMENTE com JSON válido (sem texto antes ou depois) no formato:`,
        `{`,
        `  "results": [`,
        `    {`,
        `      "title": "Nome da música",`,
        `      "composer": "Compositor",`,
        `      "artist": "Artista opcional",`,
        `      "mediaTitle": "Filme/Série/Jogo opcional",`,
        `      "genre": "Música clássica | Música brasileira | Trilhas sonoras | Música religiosa | Música popular | Música de filmes | Estudos",`,
        `      "difficulty": "Iniciante | Intermediário | Avançado",`,
        `      "keySignature": "Ex: Lá Menor",`,
        `      "timeSignature": [4, 4],`,
        `      "bpm": 92,`,
        `      "pagesCount": 3,`,
        `      "durationLabel": "3:20",`,
        `      "isPublicDomain": false,`,
        `      "description": "Descrição curta em português.",`,
        `      "chordProgression": ["Am", "F", "C", "G"],`,
        `      "events": [`,
        `        { "measure": 1, "beat": 0, "durationBeats": 2, "midiNotes": [45, 52], "hand": "esquerda", "chordSymbol": "Am" },`,
        `        { "measure": 1, "beat": 0, "durationBeats": 1, "midiNotes": [69], "hand": "direita" }`,
        `      ]`,
        `    }`,
        `  ]`,
        `}`,
      ].join('\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });

      const groundingChunks =
        response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];

      const groundingSources: Array<{ title: string; uri: string }> = [];
      const seenUris = new Set<string>();
      for (const chunk of groundingChunks) {
        const web = chunk && typeof chunk === 'object' ? (chunk as { web?: { uri?: string; title?: string } }).web : undefined;
        const safeUri = sanitizeHttpUrl(web?.uri);
        if (safeUri && !seenUris.has(safeUri)) {
          seenUris.add(safeUri);
          groundingSources.push({
            title:
              typeof web?.title === 'string' && web.title.trim()
                ? web.title.trim()
                : new URL(safeUri).hostname,
            uri: safeUri,
          });
        }
      }

      const rawText = response.text ?? '';
      const parsed = extractJsonObject(rawText);
      const rawResults = Array.isArray(parsed?.results) ? parsed.results : [];
      const results = sanitizeResults(rawResults, groundingSources);

      res.json({
        query: searchTerm,
        results,
        groundingSources,
      });
    } catch (err: unknown) {
      const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
        query?: unknown;
        category?: unknown;
      };
      const rawQuery = typeof body.query === 'string' ? body.query.trim().slice(0, 140) : '';
      const rawCategory = typeof body.category === 'string' ? body.category.trim().slice(0, 60) : '';
      const fallbackTerm = rawQuery || (rawCategory && rawCategory !== 'Todas' ? rawCategory : 'partituras piano');
      const formatted = formatGeminiSearchError(err);
      res.status(formatted.status).json({
        error: formatted.message,
        externalSearchLinks: buildExternalSearchLinks(fallbackTerm),
      });
    }
  });

  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(DIST_DIR));
    app.get('*', (_req, res) => {
      const indexFile = path.join(DIST_DIR, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build not found.');
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`KEYORA PIANO server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start KEYORA PIANO server:', err);
  process.exit(1);
});
