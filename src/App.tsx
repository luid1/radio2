/**
 * Rádio Inteligente — Lumin
 * Integração completa: Branding Lumin + Jamendo API + Ciclo de Locução (SpeechSynthesis)
 *
 * Fluxo do ciclo automático:
 *   1. INICIAR → toca música
 *   2. Volume ducking → 0.1 (fade 2 s)
 *   3. 20 s — Institucional (elogios ao Armazém da Gula)
 *   4. 40 s — Ofertas (lidas do textarea)
 *   5. 10 s — Agradecimento
 *   6. Volume sobe → 0.4 (fade 2 s)
 *   7. Toca 2 músicas completas do Jamendo
 *   8. Repete desde o passo 2
 */

import { useCallback, useEffect, useRef, useState } from "react";

/* ──────────────────────────── Tipos ──────────────────────────── */

type CyclePhase =
  | "idle"
  | "preparing"
  | "locucao_institucional"
  | "locucao_ofertas"
  | "locucao_agradecimento"
  | "tocando";

interface JamendoTrack {
  id: string;
  name: string;
  artist_name: string;
  audiodownload?: string;
  audio: string;
  image?: string;
  duration: number;
  album_name?: string;
}

interface Track {
  id: string;
  title: string;
  artist: string;
  audio: string;
  image?: string;
  duration: number;
}

/* ──────────────────────────── Config ─────────────────────────── */

const CLIENT_ID = "56d30c95";
const JAMENDO_BASE = "https://api.jamendo.com/v3.0/tracks/";
const VOLUME_DUCK = 0.1;
const VOLUME_NORMAL = 0.4;
const FADE_MS = 2000;
const PHASE_DURATIONS: Record<string, number> = {
  locucao_institucional: 20,
  locucao_ofertas: 40,
  locucao_agradecimento: 10,
};

/* Texto institucional padrão */
const INSTITUCIONAL_TEXT =
  "Você está ouvindo a Rádio Lumin, a inteligência que conecta você ao melhor do Armazém da Gula! Aqui, qualidade é tradição, preço baixo é compromisso, e o atendimento é de família. O Armazém da Gula é o lugar onde sua casa fica mais completa, sua mesa mais farta, e seu bolso agradece. Venha conferir as ofertas do dia no Armazém da Gula!";

const AGRADECIMENTO_TEXT =
  "Obrigado pela sua audiência! Continue com a gente na Rádio Lumin. Armazém da Gula, sempre com você!";

const DEFAULT_OFFERS = `🥩 Picanha Premium - R$ 69,90/kg (Hoje até 20h)
🍕 Pizza Família 45cm - 2 sabores por R$ 59,90
🥤 Combo Refri 2L + Batata G + Burger - R$ 39,90
☕ Café Gourmet Torrado - Leve 2 pague 1
🍫 Chocoblast 200g - R$ 9,90 (estoque limitado)`;

/* ──────────────────────────── Jamendo ────────────────────────── */

async function jamendoFetch(
  search: string,
  limit = 20
): Promise<JamendoTrack[]> {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    format: "jsonpretty",
    limit: String(limit),
    include: "musicinfo",
    audioformat: "mp32",
    imagesize: "200",
  });

  if (search.trim()) {
    params.set("search", search.trim());
    params.set("fuzzy", "true");
    params.set("order", "searchweight");
  } else {
    params.set("order", "popularity_week");
  }

  const url = `${JAMENDO_BASE}?${params.toString()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jamendo HTTP ${res.status}`);
  const json = await res.json();
  return (json.results ?? []).filter((t: JamendoTrack) => !!t.audio);
}

function toTrack(t: JamendoTrack): Track {
  return {
    id: t.id,
    title: t.name,
    artist: t.artist_name,
    audio: t.audio,
    image: t.image,
    duration: t.duration,
  };
}

/* ──────────────────────────── Helpers ────────────────────────── */

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatDuration(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${pad2(s)}`;
}

/* ──────────────────────────── Component ──────────────────────── */

export default function App() {
  /* Estado UI */
  const [phase, setPhase] = useState<CyclePhase>("idle");
  const [isRunning, setIsRunning] = useState(false);
  const [offers, setOffers] = useState(DEFAULT_OFFERS);
  const [searchInput, setSearchInput] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Track[]>([]);
  const [nowPlaying, setNowPlaying] = useState<Track | null>(null);
  const [volumePct, setVolumePct] = useState(VOLUME_NORMAL * 100);

  /* Countdown da fase atual (contagem regressiva) */
  const [countdown, setCountdown] = useState<number | null>(null);

  /* Mensagem de status legível */
  const [statusMsg, setStatusMsg] = useState("Aguardando ativação");

  /* Contador de músicas do ciclo (0 → 1 → 2 → recomeça locução) */
  const [musicIdx, setMusicIdx] = useState(0); // 0-based, 0 e 1 = 2 músicas

  /* Cronômetro geral (conta pra cima durante músicas) */
  const [elapsed, setElapsed] = useState(0);

  /* ═══════════ Refs ═══════════ */
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playlistRef = useRef<Track[]>([]); // ← array global "playlist"
  const playlistCursorRef = useRef(0); // próxima faixa da playlist
  const cycleRef = useRef(false); // ciclo está ativo?
  const musicCountRef = useRef(0); // quantas músicas já tocaram neste bloco
  const fadeRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const elapsedRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const speechTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cycleLockRef = useRef(false); // evita chamadas concorrentes ao ciclo

  /* ═══════════ Fade de volume ═══════════ */

  const clearFade = useCallback(() => {
    if (fadeRef.current) {
      clearInterval(fadeRef.current);
      fadeRef.current = null;
    }
  }, []);

  const fadeTo = useCallback((target: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    clearFade();
    const start = audio.volume;
    const delta = target - start;
    const steps = 40;
    const interval = FADE_MS / steps;
    let i = 0;
    fadeRef.current = setInterval(() => {
      i++;
      // easeInOutQuad
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      audio.volume = Math.max(0, Math.min(1, start + delta * ease));
      if (i >= steps) {
        clearFade();
        audio.volume = Math.max(0, Math.min(1, target));
        setVolumePct(Math.round(audio.volume * 100));
      }
    }, interval);
  }, [clearFade]);

  const volumeBaixo = useCallback(() => fadeTo(VOLUME_DUCK), [fadeTo]);
  const volumeNormal = useCallback(() => fadeTo(VOLUME_NORMAL), [fadeTo]);

  /* expõe no window para debug */
  useEffect(() => {
    (window as any).volumeBaixo = volumeBaixo;
    (window as any).volumeNormal = volumeNormal;
    (window as any).playlist = playlistRef.current;
  }, [volumeBaixo, volumeNormal]);

  /* ═══════════ Countdown ═══════════ */

  const startCountdown = useCallback((seconds: number) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setCountdown(seconds);
    let left = seconds;
    countdownRef.current = setInterval(() => {
      left--;
      setCountdown(left);
      if (left <= 0) {
        clearInterval(countdownRef.current!);
        countdownRef.current = null;
        setCountdown(null);
      }
    }, 1000);
  }, []);

  const stopCountdown = useCallback(() => {
    if (countdownRef.current) {
      clearInterval(countdownRef.current);
      countdownRef.current = null;
    }
    setCountdown(null);
  }, []);

  /* ═══════════ Cronômetro elapsed ═══════════ */

  const startElapsed = useCallback(() => {
    if (elapsedRef.current) clearInterval(elapsedRef.current);
    setElapsed(0);
    elapsedRef.current = setInterval(() => setElapsed((e) => e + 1), 1000);
  }, []);

  const stopElapsed = useCallback(() => {
    if (elapsedRef.current) {
      clearInterval(elapsedRef.current);
      elapsedRef.current = null;
    }
    setElapsed(0);
  }, []);

  /* ═══════════ Speech ═══════════ */

  const speak = useCallback(
    (text: string, maxMs: number): Promise<void> =>
      new Promise((resolve) => {
        window.speechSynthesis.cancel();
        // carrega vozes
        const loadVoices = () => {
          const voices = window.speechSynthesis.getVoices();
          return voices.find((v) => v.lang.startsWith("pt")) ?? voices[0];
        };

        // Chrome carrega async
        window.speechSynthesis.onvoiceschanged = () => loadVoices();

        const utt = new SpeechSynthesisUtterance(text);
        utt.lang = "pt-BR";
        utt.rate = 1.0;
        utt.pitch = 1.0;
        const voice = loadVoices();
        if (voice) utt.voice = voice;

        utt.onend = () => resolve();
        utt.onerror = () => resolve();

        window.speechSynthesis.speak(utt);

        // safety timeout
        if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
        speechTimeoutRef.current = setTimeout(() => {
          window.speechSynthesis.cancel();
          resolve();
        }, maxMs + 2000);
      }),
    []
  );

  /* ═══════════ Tocar faixa ═══════════ */

  const playTrack = useCallback(async (track: Track) => {
    const audio = audioRef.current;
    if (!audio) return;
    setNowPlaying(track);
    audio.src = track.audio;
    try {
      await audio.play();
    } catch {
      /* autoplay bloqueado */
    }
  }, []);

  /* ═══════════ Playlist helpers ═══════════ */

  const pushToPlaylist = useCallback((tracks: Track[]) => {
    // adiciona ao fim, evita duplicatas por id
    const existing = new Set(playlistRef.current.map((t) => t.id));
    for (const t of tracks) {
      if (!existing.has(t.id)) {
        playlistRef.current.push(t);
        existing.add(t.id);
      }
    }
    // atualiza window
    (window as any).playlist = playlistRef.current;
  }, []);

  const nextFromPlaylist = useCallback((): Track | null => {
    if (playlistRef.current.length === 0) return null;
    const idx = playlistCursorRef.current % playlistRef.current.length;
    playlistCursorRef.current = idx + 1;
    return playlistRef.current[idx]!;
  }, []);

  // A reposição automática é feita dentro de playNext() quando necessário

  /* ═══════════ Toca próxima faixa ═══════════ */

  const playNext = useCallback(async () => {
    // tenta pegar da playlist
    let track = nextFromPlaylist();

    // se não tem, busca emergencial
    if (!track) {
      try {
        const raw = await jamendoFetch("", 15);
        const tracks = raw.map(toTrack);
        pushToPlaylist(tracks);
        track = nextFromPlaylist();
      } catch {
        return;
      }
    }

    if (track) {
      await playTrack(track);
    }
  }, [nextFromPlaylist, playTrack, pushToPlaylist]);

  /* ═══════════ Quando uma música acaba ═══════════ */

  const onTrackEnded = useCallback(async () => {
    if (!cycleRef.current) return;

    // Se estamos em fase de locução, não deve acontecer, mas se acontecer:
    if (phase.startsWith("locucao_")) return;

    musicCountRef.current++;

    if (musicCountRef.current >= 2) {
      // 2 músicas tocadas → reinicia ciclo de locução
      musicCountRef.current = 0;
      setMusicIdx(0);
      startAnnouncementCycle();
    } else {
      // Toca próxima música
      setMusicIdx(musicCountRef.current);
      setStatusMsg(`Tocando: Música ${musicCountRef.current + 1} de 2`);
      startElapsed();
      await playNext();
    }
  }, [phase, playNext, startElapsed]);

  /* ═══════════ Ciclo de Locução ═══════════ */

  const startAnnouncementCycle = useCallback(async () => {
    if (cycleLockRef.current) return;
    cycleLockRef.current = true;

    try {
      if (!cycleRef.current) return;

      /* ── Ducking ── */
      volumeBaixo();
      setPhase("preparing");
      setStatusMsg("Preparando locução…");
      await new Promise((r) => setTimeout(r, FADE_MS + 200));

      /* ── 20 s — Institucional ── */
      if (!cycleRef.current) return;
      setPhase("locucao_institucional");
      setStatusMsg("Anunciando: Apresentando o Armazém da Gula");
      startCountdown(PHASE_DURATIONS.locucao_institucional);
      await speak(INSTITUCIONAL_TEXT, PHASE_DURATIONS.locucao_institucional * 1000);

      /* ── 40 s — Ofertas ── */
      if (!cycleRef.current) return;
      setPhase("locucao_ofertas");
      setStatusMsg("Anunciando: Lendo ofertas do dia");
      startCountdown(PHASE_DURATIONS.locucao_ofertas);
      const offersLines = offers
        .split("\n")
        .filter((l) => l.trim().length > 0);
      const offersClean = offersLines
        .map((l) => l.replace(/[🥩🍕🥤☕🍫🎵🔥⭐]/g, "").trim())
        .join(". ");
      const ofertasText = `Atenção para as ofertas imperdíveis do Armazém da Gula! ${offersClean}. Corra, são ofertas por tempo limitado! Armazém da Gula, o melhor preço da cidade, todo dia!`;
      await speak(ofertasText, PHASE_DURATIONS.locucao_ofertas * 1000);

      /* ── 10 s — Agradecimento ── */
      if (!cycleRef.current) return;
      setPhase("locucao_agradecimento");
      setStatusMsg("Anunciando: Agradecimento final");
      startCountdown(PHASE_DURATIONS.locucao_agradecimento);
      await speak(AGRADECIMENTO_TEXT, PHASE_DURATIONS.locucao_agradecimento * 1000);

      /* ── Volta música ── */
      if (!cycleRef.current) return;
      stopCountdown();
      volumeNormal();
      musicCountRef.current = 0;
      setMusicIdx(0);
      setPhase("tocando");
      setStatusMsg("Tocando: Música 1 de 2");
      await new Promise((r) => setTimeout(r, FADE_MS + 200));
      startElapsed();
      await playNext();
    } finally {
      cycleLockRef.current = false;
    }
  }, [
    offers,
    playNext,
    speak,
    startCountdown,
    stopCountdown,
    volumeBaixo,
    volumeNormal,
    startElapsed,
  ]);

  /* ═══════════ ATIVAR rádio ═══════════ */

  const activateRadio = useCallback(async () => {
    /* Inicializa áudio */
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = "auto";
      a.crossOrigin = "anonymous";
      a.volume = VOLUME_NORMAL;
      audioRef.current = a;

      a.addEventListener("ended", onTrackEnded);
      a.addEventListener("error", () => {
        if (cycleRef.current) playNext();
      });
    }

    setIsRunning(true);
    cycleRef.current = true;
    cycleLockRef.current = false;
    musicCountRef.current = 0;
    setMusicIdx(0);
    setPhase("preparing");
    setStatusMsg("Carregando músicas…");

    /* Popula playlist com músicas populares */
    try {
      const raw = await jamendoFetch("", 20);
      const tracks = raw.map(toTrack);
      pushToPlaylist(tracks);
      setSearchResults(tracks);
    } catch {
      /* continua mesmo sem resultados */
    }

    /* Se há músicas na playlist, toca a primeira imediatamente */
    const first = nextFromPlaylist();
    if (first) {
      await playTrack(first);
    }

    /* Inicia ciclo de locução */
    startAnnouncementCycle();
  }, [
    nextFromPlaylist,
    onTrackEnded,
    playNext,
    playTrack,
    pushToPlaylist,
    startAnnouncementCycle,
  ]);

  /* ═══════════ PARAR rádio ═══════════ */

  const stopRadio = useCallback(() => {
    cycleRef.current = false;
    setIsRunning(false);
    setPhase("idle");
    setStatusMsg("Rádio parada — pronto para reiniciar");
    stopCountdown();
    stopElapsed();
    window.speechSynthesis.cancel();
    if (speechTimeoutRef.current) {
      clearTimeout(speechTimeoutRef.current);
      speechTimeoutRef.current = null;
    }
    clearFade();
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.src = "";
    }
    setNowPlaying(null);
    setMusicIdx(0);
    musicCountRef.current = 0;
    setVolumePct(40);
    if (a) a.volume = VOLUME_NORMAL;
    cycleLockRef.current = false;
  }, [clearFade, stopCountdown, stopElapsed]);

  /* ═══════════ Buscar no Jamendo (pesquisa manual) ═══════════ */

  useEffect(() => {
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const raw = await jamendoFetch(searchInput, 20);
        const tracks = raw.map(toTrack);
        setSearchResults(tracks);
        // adiciona à playlist global
        pushToPlaylist(tracks);
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput, pushToPlaylist]);

  /* ═══════════ Cleanup ═══════════ */

  useEffect(() => {
    return () => {
      stopCountdown();
      stopElapsed();
      clearFade();
      window.speechSynthesis.cancel();
      if (speechTimeoutRef.current) clearTimeout(speechTimeoutRef.current);
      audioRef.current?.pause();
    };
  }, [clearFade, stopCountdown, stopElapsed]);

  /* ═══════════ Handlers UI ═══════════ */

  const handlePlayFromSearch = useCallback(
    async (track: Track) => {
      /* Ao clicar numa música, carrega no player e salva como ponto de partida */
      if (!isRunning) {
        // ativa a rádio se estiver parada
        await activateRadio();
        return;
      }
      // coloca como próxima (inserir no cursor)
      playlistRef.current.splice(playlistCursorRef.current, 0, track);
      await playTrack(track);
      setPhase("tocando");
      setStatusMsg(`Tocando: ${track.title}`);
    },
    [activateRadio, isRunning, playTrack]
  );

  const handleAddToQueue = useCallback(
    (track: Track) => {
      pushToPlaylist([track]);
    },
    [pushToPlaylist]
  );

  /* ═══════════ Display ═══════════ */

  const countdownDisplay =
    countdown !== null ? `${pad2(0)}:${pad2(countdown)}` : `${pad2(Math.floor(elapsed / 60))}:${pad2(elapsed % 60)}`;

  const phaseLabel: Record<CyclePhase, string> = {
    idle: "Aguardando",
    preparing: "Preparando…",
    locucao_institucional: "Fase: Institucional",
    locucao_ofertas: "Fase: Ofertas",
    locucao_agradecimento: "Fase: Agradecimento",
    tocando: "Fase: Música",
  };

  const isLocution = phase.startsWith("locucao_");

  const statusDot =
    phase === "tocando"
      ? "bg-emerald-500"
      : isLocution
        ? "bg-amber-500"
        : phase === "preparing"
          ? "bg-violet-500"
          : "bg-slate-400";

  const statusBorder =
    phase === "tocando"
      ? "border-emerald-200"
      : isLocution
        ? "border-amber-200"
        : phase === "preparing"
          ? "border-violet-200"
          : "border-slate-200";

  const handleSearch = useCallback(async (q: string) => {
    setSearchInput(q);
    if (q.trim().length < 1) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        format: "jsonpretty",
        limit: "20",
        namesearch: q.trim(),
        include: "musicinfo",
        audioformat: "mp32",
        imagesize: "200",
      });
      const res = await fetch(`${JAMENDO_BASE}?${params.toString()}`);
      const json = await res.json();
      const tracks = (json.results ?? []).filter((t: any) => !!t.audio);
      setSearchResults(tracks.map(toTrack));
    } catch (e) {
      console.error(e);
    } finally {
      setSearching(false);
    }
  }, []);

  /* ═══════════ Render ═══════════ */

  return (
    <div className="min-h-screen bg-white text-slate-900 selection:bg-blue-600/20 selection:text-blue-700">
      {/* Background decorativo */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-[radial-gradient(1200px_600px_at_80%_-10%,rgba(37,99,235,0.18),transparent_60%),radial-gradient(900px_500px_at_10%_110%,rgba(37,99,235,0.12),transparent_60%)]" />
        <svg className="absolute inset-0 h-full w-full opacity-[0.06]" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path d="M32 0H0V32" fill="none" stroke="#0f172a" strokeWidth="0.5" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
      </div>

      {/* ═══ Header ═══ */}
      <header className="sticky top-0 z-30 border-b border-slate-200/70 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 lg:px-8">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className="absolute -inset-1 rounded-2xl bg-blue-600/20 blur-md" />
              <div className="relative grid h-10 w-10 place-items-center rounded-2xl bg-[#2563eb] text-white shadow-lg shadow-blue-600/20 ring-1 ring-white/40">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path d="M12 3v4m0 10v4M3 12h4m10 0h4M6.5 6.5l2.8 2.8M14.7 14.7l2.8 2.8M17.5 6.5l-2.8 2.8M9.3 14.7l-2.8 2.8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                </svg>
              </div>
            </div>
            <div className="flex flex-col">
              <span className="font-[Comfortaa] text-[26px] font-bold leading-none tracking-tight text-[#0b1220]">
                Lumin
              </span>
              <span className="mt-0.5 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-500">
                Rádio Inteligente
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={volumeBaixo}
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 shadow-sm hover:bg-slate-50 transition"
              title="volumeBaixo() → 0.1 com fade 2s"
            >
              🔉 Baixo
            </button>
            <button
              onClick={volumeNormal}
              className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 transition"
              title="volumeNormal() → 0.4 com fade 2s"
            >
              🔊 Normal
            </button>
            <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">
              <span className={`h-1.5 w-1.5 rounded-full ${isRunning ? "animate-pulse bg-emerald-500" : "bg-slate-400"}`} />
              {isRunning ? "Ao Vivo" : "Jamendo"}
            </span>
          </div>
        </div>
      </header>

      {/* ═══ Main ═══ */}
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:px-8">

        {/* ─── Painel de Status ─── */}
        <section className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white/70 shadow-[0_10px_40px_-20px_rgba(2,6,23,0.25)] backdrop-blur-xl">
          <div className="pointer-events-none absolute -right-24 -top-24 h-64 w-64 rounded-full bg-[#2563eb]/15 blur-3xl" />
          <div className="pointer-events-none absolute -left-24 -bottom-24 h-64 w-64 rounded-full bg-cyan-400/10 blur-3xl" />

          <div className="grid gap-4 p-5 sm:grid-cols-3 sm:p-6">

            {/* Card 1 — Fase Atual + Status */}
            <div className="group relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="absolute inset-0 bg-gradient-to-br from-blue-600/5 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              <div className="relative flex items-start justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Fase Atual</p>
                  <h3 className="mt-1 text-lg font-semibold text-slate-900">{phaseLabel[phase]}</h3>
                </div>
                <div className={`grid h-9 w-9 place-items-center rounded-xl border bg-white shadow-sm ${statusBorder}`}>
                  <span className={`h-2.5 w-2.5 rounded-full ${statusDot} ${isLocution ? "animate-pulse" : ""}`} />
                </div>
              </div>

              <div className="mt-4">
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-medium text-slate-500">Status</span>
                  <span className="text-[11px] font-medium text-slate-700">{statusMsg}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      isLocution ? "bg-amber-500 w-[70%]" : phase === "tocando" ? "bg-emerald-500 w-full" : "bg-slate-400 w-[10%]"
                    }`}
                  />
                </div>
              </div>
            </div>

            {/* Card 2 — Cronômetro + Controles */}
            <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-start justify-between">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">
                    {countdown !== null ? "⏳ Tempo Restante" : "⏱ Cronômetro"}
                  </p>
                  <div className="mt-2 flex items-end gap-2">
                    <div className={`font-mono text-4xl font-semibold tracking-tight ${countdown !== null ? "text-amber-600" : "text-slate-900"}`}>
                      {countdownDisplay}
                    </div>
                    {countdown !== null && (
                      <span className="mb-1 text-[11px] font-medium uppercase tracking-wider text-amber-600">restantes</span>
                    )}
                  </div>
                </div>
                {countdown !== null && (
                  <div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-50 text-amber-600 ring-1 ring-amber-200">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <polyline points="12 6 12 12 16 14" />
                    </svg>
                  </div>
                )}
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={isRunning ? stopRadio : activateRadio}
                  className={`inline-flex items-center gap-1.5 rounded-xl border px-4 py-2 text-sm font-semibold shadow-sm transition ${
                    isRunning
                      ? "border-rose-200 bg-rose-600 text-white hover:bg-rose-700"
                      : "border-blue-200 bg-[#2563eb] text-white hover:brightness-110"
                  }`}
                >
                  {isRunning ? (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M6 6h12v12H6z" />
                      </svg>
                      PARAR
                    </>
                  ) : (
                    <>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      INICIAR RÁDIO LUMIN
                    </>
                  )}
                </button>
              </div>

              <div className="mt-3 flex items-center justify-between">
                <div className="text-[12px] text-slate-500">Volume: {volumePct}%</div>
                <input
                  aria-label="Volume"
                  type="range"
                  min={0}
                  max={100}
                  value={volumePct}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setVolumePct(v);
                    if (audioRef.current) audioRef.current.volume = v / 100;
                    clearFade();
                  }}
                  className="h-1.5 w-36 cursor-pointer appearance-none rounded-full bg-slate-200 accent-[#2563eb]"
                />
              </div>
              <div className="mt-1 flex gap-2">
                <button onClick={volumeBaixo} className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-50 transition">
                  volumeBaixo()
                </button>
                <button onClick={volumeNormal} className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-1 text-[11px] text-blue-700 hover:bg-blue-100 transition">
                  volumeNormal()
                </button>
                <span className="ml-auto text-[11px] text-slate-500">fade 2 s</span>
              </div>
            </div>

            {/* Card 3 — Agora Tocando */}
            <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">Agora Tocando</p>
              {nowPlaying ? (
                <div className="mt-2 flex items-center gap-3">
                  <div className="relative h-14 w-14 overflow-hidden rounded-xl ring-1 ring-slate-200">
                    {nowPlaying.image ? (
                      <img src={nowPlaying.image} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="grid h-full w-full place-items-center bg-gradient-to-br from-[#2563eb] to-blue-700 text-white">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
                          <path d="M9 18V6l10 6-10 6z" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold text-slate-900">{nowPlaying.title}</p>
                    <p className="truncate text-[12px] text-slate-500">{nowPlaying.artist}</p>
                    {nowPlaying.duration > 0 && (
                      <p className="text-[11px] text-slate-400 mt-0.5">{formatDuration(nowPlaying.duration)}</p>
                    )}
                  </div>
                </div>
              ) : (
                <p className="mt-3 text-sm text-slate-500">Nada em reprodução. Ative a rádio para começar.</p>
              )}

              <div className="mt-3 flex flex-wrap gap-1.5">
                {isRunning && phase === "tocando" && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-1 text-[11px] font-medium text-emerald-700">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
                    Música {musicIdx + 1} de 2
                  </span>
                )}
                {isRunning && isLocution && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-700">
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />
                    Locução ativa
                  </span>
                )}
                <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] text-slate-600">
                  {playlistRef.current.length} na playlist
                </span>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => audioRef.current?.play()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 transition"
                >
                  ▶ Play
                </button>
                <button
                  onClick={() => audioRef.current?.pause()}
                  className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[12px] font-medium text-slate-700 hover:bg-slate-50 transition"
                >
                  ❚❚ Pause
                </button>
                <button
                  onClick={playNext}
                  className="inline-flex items-center gap-1 rounded-lg border border-blue-200 bg-blue-50 px-2.5 py-1 text-[12px] font-medium text-blue-700 hover:bg-blue-100 transition"
                >
                  ⏭ Próxima
                </button>
              </div>
            </div>
          </div>

          {/* Barra inferior do painel */}
          <div className="border-t border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-5 py-5 sm:px-6">
            <div className="flex flex-col items-stretch justify-between gap-3 sm:flex-row sm:items-center">
              <div className="flex items-center gap-3">
                <div className="grid h-10 w-10 place-items-center rounded-2xl bg-[#2563eb] text-white shadow-lg shadow-blue-600/25">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 11a8 8 0 1 1 16 0v1a2 2 0 0 1-2 2h-1" />
                    <path d="M12 19v3" />
                    <path d="M8 22h8" />
                    <circle cx="12" cy="11" r="3" />
                  </svg>
                </div>
                <div>
                  <p className="text-sm font-semibold text-slate-900">Ciclo Automático</p>
                  <p className="text-xs text-slate-500">20s institucional → 40s ofertas → 10s agradecimento → 2 músicas → repete</p>
                </div>
              </div>

              {!isRunning && (
                <button
                  onClick={activateRadio}
                  className="group relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-[#2563eb] px-6 py-3 text-[15px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(37,99,235,0.7)] ring-1 ring-white/20 transition hover:brightness-110 active:brightness-95 sm:w-auto"
                >
                  <span className="absolute inset-0 -translate-x-full bg-[linear-gradient(110deg,transparent,rgba(255,255,255,0.25),transparent)] transition group-hover:translate-x-full" />
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  ATIVAR RÁDIO LUMIN
                </button>
              )}

              {isRunning && (
                <button
                  onClick={stopRadio}
                  className="group relative inline-flex w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-rose-600 px-6 py-3 text-[15px] font-semibold text-white shadow-[0_10px_30px_-10px_rgba(220,38,38,0.5)] ring-1 ring-white/20 transition hover:bg-rose-700 active:bg-rose-800 sm:w-auto"
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                  PARAR RÁDIO
                </button>
              )}
            </div>
          </div>
        </section>

        {/* ─── Duas Colunas ─── */}
        <section className="mt-6 grid gap-6 lg:grid-cols-2">

          {/* Coluna Esquerda — Ofertas */}
          <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white/80 shadow-[0_10px_40px_-20px_rgba(2,6,23,0.2)] backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-slate-200/70 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-rose-50 text-rose-600 ring-1 ring-rose-100">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M3 11l8-8 10 10-8 8-10-10z" />
                    <path d="M7 7l2 2" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-[15px] font-semibold text-slate-900">Ofertas Armazém da Gula</h2>
                  <p className="text-[12px] text-slate-500">Lidas pela IA por 40 s no ciclo</p>
                </div>
              </div>
              <button
                onClick={() => setOffers(DEFAULT_OFFERS)}
                className="rounded-xl border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm hover:bg-slate-50 transition"
              >
                Restaurar
              </button>
            </div>

            <div className="p-5">
              <label className="mb-2 block text-[12px] font-medium text-slate-600">Texto das ofertas (lido pela IA)</label>
              <div className="relative">
                <textarea
                  value={offers}
                  onChange={(e) => setOffers(e.target.value)}
                  rows={10}
                  placeholder="Cole aqui as ofertas do dia…"
                  className="peer w-full resize-y rounded-2xl border border-slate-200 bg-white p-3.5 text-[14px] leading-6 text-slate-800 shadow-inner outline-none ring-0 placeholder:text-slate-400 focus:border-[#2563eb]/40 focus:ring-4 focus:ring-[#2563eb]/10"
                />
                <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-slate-200 peer-focus:ring-[#2563eb]/30" />
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {offers
                  .split("\n")
                  .filter(Boolean)
                  .slice(0, 4)
                  .map((line, i) => (
                    <div key={i} className="rounded-2xl border border-slate-200 bg-slate-50/70 p-3">
                      <p className="line-clamp-3 text-[12.5px] text-slate-700">{line}</p>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Coluna Direita — Pesquisar Músicas */}
          <div className="relative overflow-hidden rounded-3xl border border-slate-200 bg-white/80 shadow-[0_10px_40px_-20px_rgba(2,6,23,0.2)] backdrop-blur-xl">
            <div className="flex items-center justify-between border-b border-slate-200/70 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-50 text-[#2563eb] ring-1 ring-blue-100">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <path d="M21 21l-4.3-4.3" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-[15px] font-semibold text-slate-900">Pesquisar Músicas</h2>
                  <p className="text-[12px] text-slate-500">
                    API Jamendo · Client ID: {CLIENT_ID}
                  </p>
                </div>
              </div>
              <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] text-slate-600">
                {searching ? "buscando…" : `${searchResults.length} resultados`}
              </span>
            </div>

              <div className="p-5">
              {/* Input de busca */}
              <div className="relative">
                <input
                  value={searchInput}
                  onChange={(e) => handleSearch(e.target.value)}
                  placeholder="Busque por título, artista…"
                  className="peer w-full rounded-2xl border border-slate-200 bg-white py-3 pl-10 pr-3 text-[14px] text-slate-800 shadow-inner outline-none placeholder:text-slate-400 focus:border-[#2563eb]/40 focus:ring-4 focus:ring-[#2563eb]/10"
                />
                <svg className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
                <div className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-inset ring-slate-200 peer-focus:ring-[#2563eb]/30" />
              </div>

              {/* Lista de resultados */}
              <div className="mt-4 max-h-[340px] overflow-auto rounded-2xl border border-slate-200">
                <ul className="divide-y divide-slate-100">
                  {searchResults.map((s) => (
                    <li key={s.id} className="group flex items-center justify-between gap-3 bg-white px-4 py-3 hover:bg-slate-50/70 transition">
                      <div className="flex min-w-0 items-center gap-3">
                        <div className="h-10 w-10 overflow-hidden rounded-lg bg-slate-100 ring-1 ring-slate-200 flex-shrink-0">
                          {s.image ? (
                            <img src={s.image} alt="" className="h-full w-full object-cover" />
                          ) : (
                            <div className="grid h-full w-full place-items-center text-slate-400">
                              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                                <path d="M9 18V6l10 6-10 6z" />
                              </svg>
                            </div>
                          )}
                        </div>
                        <div className="min-w-0">
                          <p className="truncate text-[14px] font-medium text-slate-900">
                            {s.title} <span className="text-slate-400">•</span>{" "}
                            <span className="font-normal text-slate-600">{s.artist}</span>
                          </p>
                          <div className="mt-1 flex flex-wrap gap-1.5">
                            {s.duration > 0 && (
                              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] text-slate-600">
                                {formatDuration(s.duration)}
                              </span>
                            )}
                            <span className="rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600">
                              jamendo
                            </span>
                          </div>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          onClick={() => handleAddToQueue(s)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-blue-200 bg-blue-50 px-2.5 py-1.5 text-xs font-medium text-blue-700 transition hover:bg-blue-100"
                          title="Adicionar à playlist"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          +
                        </button>
                        <button
                          onClick={() => handlePlayFromSearch(s)}
                          className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-50"
                          title="Tocar agora"
                        >
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M8 5v14l11-7z" />
                          </svg>
                          Tocar
                        </button>
                      </div>
                    </li>
                  ))}
                  {!searching && searchResults.length === 0 && (
                    <li className="px-4 py-8 text-center text-sm text-slate-500">
                      Nenhuma música encontrada. Tente buscar algo!
                    </li>
                  )}
                  {searching && (
                    <li className="px-4 py-8 text-center text-sm text-slate-500">
                      <span className="inline-block animate-pulse">Buscando no Jamendo…</span>
                    </li>
                  )}
                </ul>
              </div>
            </div>
          </div>
        </section>

        {/* ─── Footer info ─── */}
        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          {[
            {
              title: "Ciclo Automático",
              value: "SpeechSynthesis",
              desc: "20s institucional + 40s ofertas + 10s agradecimento",
            },
            {
              title: "Ducking Suave",
              value: "fade 2 s",
              desc: `volumeBaixo(${VOLUME_DUCK}) e volumeNormal(${VOLUME_NORMAL})`,
            },
            {
              title: "Sequência",
              value: "2 músicas",
              desc: "Depois reinicia o ciclo de locução automaticamente",
            },
          ].map((c) => (
            <div key={c.title} className="rounded-2xl border border-slate-200 bg-white/70 p-4 shadow-sm backdrop-blur">
              <p className="text-[11px] font-semibold uppercase tracking-widest text-slate-500">{c.title}</p>
              <p className="mt-1 text-[15px] font-semibold text-slate-900">{c.value}</p>
              <p className="mt-1 text-[13px] text-slate-600">{c.desc}</p>
            </div>
          ))}
        </section>
      </main>

      {/* ═══ Footer ═══ */}
      <footer className="mx-auto max-w-6xl px-4 pb-10 pt-6 text-center text-[12px] text-slate-500 sm:px-6 lg:px-8">
        © {new Date().getFullYear()} Lumin — Rádio Inteligente com Ciclo Automático · Jamendo API
      </footer>
    </div>
  );
}
